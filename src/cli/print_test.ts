// Task 7: CLI print (`-P`) runs over the Core Client seam. The text/NDJSON
// projections are produced from canonical Core events through the service, the
// print/unattended run policy travels on the Core-owned session, and
// `root_print.ts` contains no Builder/ExecutionRuntime construction.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@opensac/assert";
import { fromFileUrl, join } from "@opensac/path";
import { defaultSettings } from "../config/settings.ts";
import {
  createFakeTUIService,
  type FakeTUIService,
  type TUIDecisionAnswer,
  type TUIPromptInput,
  type TUIService,
  type TUISessionInput,
} from "../tui/service.ts";
import { tuiBoundaryViolations } from "../architecture/guard.ts";
import { type PrintOptions, runPrintAction } from "./root_print.ts";
import {
  EVENT_RETRY,
  EVENT_RUN_FINISHED,
  EVENT_STATUS,
  EVENT_TOOL_CALL,
  EVENT_TOOL_EXECUTION_END,
  EVENT_TOOL_EXECUTION_START,
  TASK_CANCELED,
  TASK_FAILED,
  TASK_SUCCESS,
} from "../agentruntime/events.ts";

const projectRoot = fromFileUrl(new URL("../../", import.meta.url));

interface ScriptEvent {
  eventType: string;
  payload?: Record<string, unknown>;
  terminal?: boolean;
}

interface Script {
  events?: ScriptEvent[];
  requestDecision?: {
    requestId: string;
    kind: "approval" | "question";
    toolName?: string;
    question?: string;
  };
}

interface Scripted {
  service: TUIService;
  creates: TUISessionInput[];
  prompts: TUIPromptInput[];
  answers: TUIDecisionAnswer[];
}

/** Wraps the deterministic fake with a scripted run stream and recording. */
function scriptedService(script: Script): Scripted {
  const fake = createFakeTUIService();
  const creates: TUISessionInput[] = [];
  const prompts: TUIPromptInput[] = [];
  const answers: TUIDecisionAnswer[] = [];
  const runId = "run-print";
  const service: TUIService = {
    ...fake,
    createSession(input: TUISessionInput) {
      creates.push({ ...input });
      return fake.createSession(input);
    },
    prompt(input: TUIPromptInput) {
      prompts.push({ ...input });
      fake.emit(input.sessionId, runId, "run_started", { text: input.text });
      for (const event of script.events ?? []) {
        fake.emit(
          input.sessionId,
          runId,
          event.eventType,
          event.payload ?? {},
          event.terminal ?? false,
        );
      }
      if (script.requestDecision !== undefined) {
        fake.requestDecision({
          sessionId: input.sessionId,
          runId,
          requestId: script.requestDecision.requestId,
          kind: script.requestDecision.kind,
          ...(script.requestDecision.toolName === undefined
            ? {}
            : { toolName: script.requestDecision.toolName }),
          ...(script.requestDecision.question === undefined
            ? {}
            : { question: script.requestDecision.question }),
        });
      }
      return Promise.resolve({
        sessionId: input.sessionId,
        runId,
        status: "running" as const,
        agentId: "agent-lead",
      });
    },
    answerDecision(input: TUIDecisionAnswer) {
      answers.push({ ...input });
      return (fake as FakeTUIService).answerDecision(input);
    },
  };
  return {
    service: service as unknown as TUIService,
    creates,
    prompts,
    answers,
  };
}

function printOptions(overrides: Partial<PrintOptions> = {}): PrintOptions {
  return {
    prompt: "hello",
    provider: "test-provider",
    model: "test-model",
    mode: "yolo",
    thinking: "",
    workDir: Deno.cwd(),
    json: false,
    writeOut: () => {},
    writeError: () => {},
    ...overrides,
  };
}

Deno.test("print mode projects text output from canonical Core events", async () => {
  const out: string[] = [];
  const err: string[] = [];
  const scripted = scriptedService({
    events: [
      { eventType: "text_delta", payload: { text: "Hello " } },
      { eventType: "text_delta", payload: { text: "world" } },
      {
        eventType: "tool_call",
        payload: {
          agentEvent: {
            type: EVENT_TOOL_CALL,
            toolCall: { id: "t1", name: "bash" },
            toolArgs: { command: "ls" },
          },
        },
      },
      {
        eventType: "tool_execution_start",
        payload: {
          agentEvent: { type: EVENT_TOOL_EXECUTION_START, toolName: "bash" },
        },
      },
      {
        eventType: "tool_execution_end",
        payload: {
          agentEvent: { type: EVENT_TOOL_EXECUTION_END, toolName: "bash" },
        },
      },
      {
        eventType: "run_finished",
        payload: {
          status: "completed",
          agentEvent: { type: EVENT_RUN_FINISHED, status: TASK_SUCCESS },
        },
        terminal: true,
      },
    ],
  });
  const result = await runPrintAction(
    printOptions({
      writeOut: (line) => out.push(line),
      writeError: (line) => err.push(line),
    }),
    { settings: defaultSettings(), service: scripted.service },
  );
  assertEquals(result.exitCode, 0);
  assertStringIncludes(out.join("\n"), "Hello world");
  assertStringIncludes(err.join("\n"), "Using test-provider/test-model");
  assertStringIncludes(err.join("\n"), "[tool: bash]");
  assertStringIncludes(err.join("\n"), "[running: bash]");
  assert(err.includes("done"), `expected "done" in ${JSON.stringify(err)}`);
  // The Core-owned session carries the print/unattended run policy.
  assertEquals(scripted.creates.length, 1);
  assertEquals(scripted.creates[0].source, "cli");
  assertEquals(scripted.creates[0].approvalPolicy, "print");
  assertEquals(scripted.creates[0].questionPolicy, "unattended");
  assertEquals(scripted.prompts[0].text, "hello");
  assertEquals(scripted.prompts[0].mode, "yolo");
});

Deno.test("print mode projects NDJSON output from canonical Core events", async () => {
  const out: string[] = [];
  const scripted = scriptedService({
    events: [
      { eventType: "text_delta", payload: { text: "Hi" } },
      {
        eventType: "thinking_delta",
        payload: { text: "pondering" },
      },
      {
        eventType: "tool_call",
        payload: {
          agentEvent: {
            type: EVENT_TOOL_CALL,
            toolCall: { id: "t1", name: "bash" },
            toolArgs: { command: "ls" },
          },
        },
      },
      {
        eventType: "run_finished",
        payload: {
          status: "completed",
          agentEvent: { type: EVENT_RUN_FINISHED, status: TASK_SUCCESS },
        },
        terminal: true,
      },
    ],
  });
  const result = await runPrintAction(
    printOptions({ json: true, writeOut: (line) => out.push(line) }),
    { settings: defaultSettings(), service: scripted.service },
  );
  assertEquals(result.exitCode, 0);
  const lines = out.map((line) => JSON.parse(line) as Record<string, unknown>);
  assertEquals(lines[0].type, "start");
  assertEquals(lines[0].provider, "test-provider");
  assertEquals(lines[0].model, "test-model");
  assertEquals(lines[1], { type: "text_delta", text: "Hi" });
  assert(lines.some((line) => line.type === "think_delta"));
  const call = lines.find((line) => line.type === "tool_call");
  assertEquals(call?.name, "bash");
  assertEquals(call?.id, "t1");
});

Deno.test("print mode fails with exit 1 when a tool needs approval", async () => {
  const err: string[] = [];
  const scripted = scriptedService({
    events: [
      {
        eventType: "approval_requested",
        payload: { approvalId: "ap-1", approvalTool: "bash" },
      },
      {
        eventType: "run_finished",
        payload: {
          status: "cancelled",
          agentEvent: { type: EVENT_RUN_FINISHED, status: TASK_CANCELED },
        },
        terminal: true,
      },
    ],
    requestDecision: { requestId: "ap-1", kind: "approval", toolName: "bash" },
  });
  const result = await runPrintAction(
    printOptions({ writeError: (line) => err.push(line) }),
    { settings: defaultSettings(), service: scripted.service },
  );
  assertEquals(result.exitCode, 1);
  assertStringIncludes(
    err.join("\n"),
    "tool approval required in print mode",
  );
  // The pending decision is answered unattended so the Core run is never wedged.
  assertEquals(scripted.answers, [
    { requestId: "ap-1", kind: "approval", approved: false },
  ]);
});

Deno.test("print mode answers questions unattended and keeps exit semantics", async () => {
  const scripted = scriptedService({
    events: [
      { eventType: "text_delta", payload: { text: "done" } },
      {
        eventType: "run_finished",
        payload: {
          status: "completed",
          agentEvent: { type: EVENT_RUN_FINISHED, status: TASK_SUCCESS },
        },
        terminal: true,
      },
    ],
    requestDecision: {
      requestId: "q-1",
      kind: "question",
      question: "pick one",
    },
  });
  const result = await runPrintAction(printOptions(), {
    settings: defaultSettings(),
    service: scripted.service,
  });
  assertEquals(result.exitCode, 0);
  assertEquals(scripted.answers, [
    { requestId: "q-1", kind: "question", answer: "" },
  ]);
});

Deno.test("print mode surfaces failed runs instead of silent success", async () => {
  // A non-completed durable run must report why it failed and exit non-zero:
  // scripts can tell a failed turn from a completed one.
  const err: string[] = [];
  const scripted = scriptedService({
    events: [
      {
        eventType: "run_finished",
        payload: {
          status: "failed",
          error: "model exploded",
          agentEvent: { type: EVENT_RUN_FINISHED, status: TASK_FAILED },
        },
        terminal: true,
      },
    ],
  });
  const result = await runPrintAction(
    printOptions({ writeError: (line) => err.push(line) }),
    { settings: defaultSettings(), service: scripted.service },
  );
  assertEquals(result.exitCode, 1);
  assertStringIncludes(err.join("\n"), "model exploded");
});

Deno.test("print mode emits terminal NDJSON records with the run status", async () => {
  const out: string[] = [];
  const completed = scriptedService({
    events: [
      {
        eventType: "run_finished",
        payload: {
          status: "completed",
          agentEvent: { type: EVENT_RUN_FINISHED, status: TASK_SUCCESS },
        },
        terminal: true,
      },
    ],
  });
  const ok = await runPrintAction(
    printOptions({ json: true, writeOut: (line) => out.push(line) }),
    { settings: defaultSettings(), service: completed.service },
  );
  assertEquals(ok.exitCode, 0);
  assertEquals(JSON.parse(out.at(-1)!), {
    type: "run_finished",
    status: "completed",
  });

  out.length = 0;
  const failed = scriptedService({
    events: [
      {
        eventType: "run_finished",
        payload: {
          status: "failed",
          error: "boom",
          agentEvent: { type: EVENT_RUN_FINISHED, status: TASK_FAILED },
        },
        terminal: true,
      },
    ],
  });
  const bad = await runPrintAction(
    printOptions({ json: true, writeOut: (line) => out.push(line) }),
    { settings: defaultSettings(), service: failed.service },
  );
  assertEquals(bad.exitCode, 1);
  assertEquals(JSON.parse(out.at(-1)!), {
    type: "run_finished",
    status: "failed",
    error: "boom",
  });
});

Deno.test("print mode mints a fresh session per run when no resume flag is given", async () => {
  // With no `-c`/`-r`/`--session`, print keeps the Go setupSession default: one
  // fresh Core-owned session per run. The resume flags are covered by the
  // dedicated tests below, so this one pins only the no-flag path.
  const terminal: ScriptEvent[] = [{
    eventType: "run_finished",
    payload: {
      status: "completed",
      agentEvent: { type: EVENT_RUN_FINISHED, status: TASK_SUCCESS },
    },
    terminal: true,
  }];
  const first = scriptedService({ events: terminal });
  await runPrintAction(printOptions(), {
    settings: defaultSettings(),
    service: first.service,
  });
  const second = scriptedService({ events: terminal });
  await runPrintAction(printOptions(), {
    settings: defaultSettings(),
    service: second.service,
  });
  assertEquals(first.creates.length, 1);
  assertEquals(second.creates.length, 1);
  assert(
    first.creates[0].sessionId === undefined ||
      first.creates[0].sessionId !== second.creates[0].sessionId,
    "each print run mints its own Core-owned session",
  );
});

Deno.test("root_print has no Builder/ExecutionRuntime construction left", () => {
  const violations = tuiBoundaryViolations(projectRoot).filter((violation) =>
    violation.file === "src/cli/root_print.ts"
  );
  assertEquals(
    violations,
    [],
    `root_print boundary violations: ${JSON.stringify(violations)}`,
  );
  const src = Deno.readTextFileSync(join(projectRoot, "src/cli/root_print.ts"));
  for (
    const pattern of [
      /\bnew\s+Builder\s*\(/,
      /\bnew\s+ExecutionRuntime\s*\(/,
      /\bcreateSessionExecutionRuntime\s*\(/,
      /\bcreateSessionRunDescriptor\s*\(/,
      /session_runtime/,
      /execution\.ts/,
    ]
  ) {
    assertEquals(pattern.exec(src), null, `root_print.ts matches ${pattern}`);
  }
});

Deno.test("print mode keeps retry progress and provider errors visible", async () => {
  const events: ScriptEvent[] = [
    {
      eventType: "agent_event",
      payload: {
        agentEvent: {
          type: EVENT_STATUS,
          statusMessage: "Retrying (attempt 4/5); waiting 24s...",
          retryStatus: true,
        },
      },
    },
    {
      eventType: "agent_event",
      payload: {
        agentEvent: {
          type: EVENT_RETRY,
          statusMessage: "Authentication Fails",
        },
      },
    },
    {
      eventType: "run_finished",
      payload: {
        status: "failed",
        error: "Authentication Fails",
        agentEvent: { type: EVENT_RUN_FINISHED, status: TASK_FAILED },
      },
      terminal: true,
    },
  ];

  // Text mode reports retry progress and the failure reason on stderr.
  const err: string[] = [];
  const scripted = scriptedService({ events });
  const result = await runPrintAction(
    printOptions({ writeError: (line) => err.push(line) }),
    { settings: defaultSettings(), service: scripted.service },
  );
  assertEquals(result.exitCode, 1);
  assertStringIncludes(err.join("\n"), "Retrying (attempt 4/5)");
  assertStringIncludes(err.join("\n"), "Authentication Fails");

  // NDJSON consumers see every status and retry record.
  const out: string[] = [];
  const scriptedJson = scriptedService({ events });
  await runPrintAction(
    printOptions({ json: true, writeOut: (line) => out.push(line) }),
    { settings: defaultSettings(), service: scriptedJson.service },
  );
  const types = out.map((line) => (JSON.parse(line) as { type: string }).type);
  assert(types.includes("status"), JSON.stringify(types));
  assert(types.includes("retry"), JSON.stringify(types));
});

Deno.test("print -c continues this directory's newest session", async () => {
  const fake = createFakeTUIService();
  // An earlier conversation in the same directory, as a previous run left it.
  const earlier = await fake.createSession({ workDir: Deno.cwd() });
  fake.seedTranscript(earlier.sessionId, [
    { role: "user", text: "the earlier turn" },
  ]);
  await fake.closeSession({ sessionId: earlier.sessionId });

  const opens: Array<{ sessionId: string; workDir?: string }> = [];
  const service: TUIService = {
    ...fake,
    openSession(input) {
      opens.push({ ...input });
      return fake.openSession(input);
    },
  };
  const result = await runPrintAction(
    printOptions({ continueSession: true }),
    { settings: defaultSettings(), service },
  );
  assertEquals(result.exitCode, 0);
  assertEquals(
    opens.map((o) => o.sessionId),
    [earlier.sessionId],
    "-c must open the persisted session instead of creating one",
  );
  assert(
    opens[0].workDir !== undefined && opens[0].workDir !== "",
    "the resume open must be scoped to a work directory",
  );
});

/** One already-terminal run stream, for tests that only assert session setup. */
function settledScript(): Scripted {
  return scriptedService({
    events: [{
      eventType: "run_finished",
      payload: {
        status: "completed",
        agentEvent: { type: EVENT_RUN_FINISHED, status: TASK_SUCCESS },
      },
      terminal: true,
    }],
  });
}

Deno.test("print without -c/-r still creates a fresh session", async () => {
  const scripted = settledScript();
  const result = await runPrintAction(
    printOptions(),
    { settings: defaultSettings(), service: scripted.service },
  );
  assertEquals(result.exitCode, 0);
  assertEquals(scripted.creates.length, 1, "no resume flags, one new session");
});

Deno.test("print with an unresolvable -r target degrades to a fresh session", async () => {
  const scripted = settledScript();
  const result = await runPrintAction(
    printOptions({ resume: "no-such-session" }),
    { settings: defaultSettings(), service: scripted.service },
  );
  // A script passing a stale id must still get its answer, not a hard failure.
  assertEquals(result.exitCode, 0);
  assertEquals(
    scripted.creates.length,
    1,
    "an unresolvable target falls back to a fresh session",
  );
});

Deno.test("print -r against an unreachable Core fails instead of silently resuming elsewhere", async () => {
  const fake = createFakeTUIService();
  const service: TUIService = {
    ...fake,
    listPersistedSessions() {
      return Promise.reject(new Error("core connection lost"));
    },
  };
  // A transport/Core failure must surface rather than degrade to a fresh
  // session, or a scripted follow-up would silently run against the wrong
  // conversation with no indication why.
  await assertRejects(
    () =>
      runPrintAction(printOptions({ resume: "session-9" }), {
        settings: defaultSettings(),
        service,
      }),
    Error,
    "core connection lost",
  );
});
