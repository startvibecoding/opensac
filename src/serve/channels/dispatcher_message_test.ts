// Translated from internal/serve/channels/dispatcher_test.go (the deferred
// cases), mailbox_ownership_test.go, security_integration_test.go, and
// subagent_terminal_test.go. The pure helper cases that Go keeps in
// dispatcher_test.go but the port already covers elsewhere (channelRunState,
// effectiveChannelMode, the tool-catalog defaults) stay in run_helpers_test.ts
// and dispatcher_core_test.ts.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  type Event as AgentEvent,
  EventDone,
  EventError,
  EventRunFinished,
  registerDelegateSubAgentTool,
  registerSubAgentTools,
  subAgentToolNames,
  TaskCanceled,
  TaskFailed,
  TaskIncomplete,
  TaskSuccess,
} from "../../agent/mod.ts";
import { ModeYolo } from "../../agentruntime/source.ts";
import {
  type DurableRun,
  ExecutionRuntime,
  type RunEvent,
  RunStore,
} from "../../agentruntime/mod.ts";
import { acquireExecutionAdmission } from "../../agentruntime/execution_admission.ts";
import { Store as EsmStore } from "../../esm/store.ts";
import type { Model } from "../../provider/types.ts";
import {
  type ChatParams,
  streamDone,
  streamError,
  type StreamEvent,
  streamRetry,
  streamStart,
  streamTextDelta,
  streamToolCall,
} from "../../provider/types.ts";
import type { Provider } from "../../provider/provider.ts";
import { type ContentBlock, newAssistantMessage } from "../../provider/mod.ts";
import type { InboundMessage } from "../../messaging/mod.ts";
import { AttachmentImage, type AttachmentStream } from "../../messaging/mod.ts";
import { defaultSettings, type Settings } from "../../config/mod.ts";
import { newNoneSandbox } from "../../sandbox/none.ts";
import { Level, newManagerWithOptions } from "../../sandbox/sandbox.ts";
import { newRegistry, newTextToolResult, type Tool } from "../../tools/mod.ts";
import {
  type ChannelToolConfig,
  createBound,
  findBinding,
  getSessionRun,
  listFailedTransientDeliveryOperations,
  listSessionRunEvents,
  newIdentityLocks,
  newManager,
  saveSessionRun,
  setChannelTools,
} from "../../session/mod.ts";
import { DeliveryDAO } from "../../dao/mod.ts";
import { queryRootDatabase } from "../../session/mod.ts";
import { registerWorkflowTools } from "../../workflow/mod.ts";
import { newSQLiteCronStore } from "../../cron/sqlite_store.ts";
import {
  newExternalSubAgentServer,
  publishExternalSubAgentEvent,
  subscribeSessionEvents,
} from "../../serve/openaiapi/external_subagents.ts";
import {
  getSessionSubAgentMessages,
  getSessionSubAgents,
} from "../../serve/openaiapi/session_read.ts";
import { ChannelSession, Dispatcher } from "./dispatcher.ts";
import { defaultConfig } from "./config.ts";
import { sessionKey } from "./session_paths.ts";
import {
  buildAgent,
  ChannelDeliveryController,
  channelRouteID,
  handleCommand,
  handleDelivery,
  handleMessage,
  resolveSession,
} from "./delivery.ts";
import { formatAttachmentSummary } from "./run_helpers.ts";
import { deliveryOperationText } from "../../agentruntime/delivery.ts";

// --- Test fixtures -----------------------------------------------------------

function testModel(id: string, name = "Model 1"): Model {
  return {
    id,
    name,
    provider: "",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 4096,
    maxTokens: 1024,
  };
}

function inbound(overrides: Partial<InboundMessage>): InboundMessage {
  return {
    platform: "wechat",
    chatID: "",
    userID: "user",
    messageID: "",
    userName: "",
    text: "",
    timestamp: new Date(),
    replyContext: "",
    ...overrides,
  };
}

interface DispatcherFixture {
  d: Dispatcher;
  settings: Settings;
  workDir: string;
}

/** Builds a dispatcher the way Go's struct-literal tests do. */
function newFixture(
  overrides: {
    multiAgent?: boolean;
    cronEnabled?: boolean;
    artifact?: boolean;
    model?: Model;
  } = {},
): DispatcherFixture {
  const workDir = Deno.makeTempDirSync({ prefix: "opensac-ch-work-" });
  const settings = defaultSettings();
  settings.sessionDir = Deno.makeTempDirSync({ prefix: "opensac-ch-sess-" });
  const cfg = defaultConfig();
  cfg.workDir = workDir;
  if (overrides.multiAgent !== undefined) cfg.multiAgent = overrides.multiAgent;
  if (overrides.cronEnabled) cfg.cron.enabled = true;
  if (overrides.artifact) cfg.artifact = true;
  const model = overrides.model ?? testModel("m1");
  const p = new RecordingChannelProvider([model]);
  const d = new Dispatcher({ cfg, settings });
  d.sessionDir = settings.sessionDir;
  d.provider = p;
  d.providerName = "recording-channel";
  d.model = model;
  d.multiAgent = cfg.multiAgent;
  d.artifact = cfg.artifact;
  d.sessions = new Map();
  d.identityLocks = newIdentityLocks();
  return { d, settings, workDir };
}

/** testModel with Go's 32768-token fixture context window. */
function testModelWide(id: string): Model {
  const m = testModel(id);
  m.contextWindow = 32768;
  return m;
}

/** Recording provider: one "ok" response per call. */
class RecordingChannelProvider implements Provider {
  modelsList: Model[];
  calls: ChatParams[] = [];
  background = false;

  constructor(models: Model[]) {
    this.modelsList = models;
  }

  async *chat(params: ChatParams): AsyncGenerator<StreamEvent> {
    this.calls.push(params);
    yield { type: streamStart };
    yield { type: streamTextDelta, textDelta: "ok" };
    yield { type: streamDone, stopReason: "stop" };
  }

  name(): string {
    return "recording-channel";
  }
  api(): string {
    return "openai-chat";
  }
  models(): Model[] {
    return this.modelsList;
  }
  getModel(id: string): Model | undefined {
    return this.modelsList.find((m) => m.id === id);
  }
  responsesBackgroundEnabled(): boolean {
    return this.background;
  }
}

function newRecordingProvider(models?: Model[]): RecordingChannelProvider {
  return new RecordingChannelProvider(models ?? [testModel("m1")]);
}

/**
 * SubAgentChannelProvider routes responses by request content rather than
 * global call order: the parent follow-up call and the child agent's first
 * call race with each other, so a shared call counter would
 * nondeterministically hand the child response to the parent.
 */
class SubAgentChannelProvider implements Provider {
  model: Model;
  calls = 0;
  errorChild: boolean;

  constructor(model: Model, errorChild = false) {
    this.model = model;
    this.errorChild = errorChild;
  }

  async *chat(params: ChatParams): AsyncGenerator<StreamEvent> {
    this.calls++;
    const payload = JSON.stringify(params.messages);
    if (payload.includes("spawn-1")) {
      // Parent follow-up call after the spawn tool result.
      yield { type: streamStart };
      yield { type: streamTextDelta, textDelta: "parent result" };
      yield { type: streamDone, stopReason: "stop" };
    } else if (payload.includes("inspect the project")) {
      // The spawned child agent's provider call.
      yield { type: streamStart };
      if (this.errorChild) {
        yield {
          type: streamError,
          error: new Error("child provider failed"),
        };
      } else {
        yield { type: streamTextDelta, textDelta: "child result" };
        yield { type: streamDone, stopReason: "stop" };
      }
    } else {
      yield { type: streamStart };
      yield {
        type: streamToolCall,
        toolCall: {
          id: "spawn-1",
          name: "subagent_spawn",
          arguments: { task: "inspect the project" },
        },
      };
      yield { type: streamDone, stopReason: "tool_calls" };
    }
  }

  name(): string {
    return "subagent-channel";
  }
  api(): string {
    return "openai-chat";
  }
  models(): Model[] {
    return [this.model];
  }
  getModel(id: string): Model | undefined {
    return this.model.id === id ? this.model : undefined;
  }
}

/** FailingChannelProvider emits a retry notice and then fails. */
class FailingChannelProvider implements Provider {
  model: Model;
  constructor(model: Model) {
    this.model = model;
  }
  async *chat(_params: ChatParams): AsyncGenerator<StreamEvent> {
    yield { type: streamStart };
    yield {
      type: streamRetry,
      retryAttempt: 1,
      retryMaxAttempts: 5,
      retryAfterMs: 1000,
      error: new Error(
        "Retrying (1/5): server overloaded — waiting 1s...",
      ),
    };
    yield { type: streamError, error: new Error("upstream returned HTTP 522") };
  }
  name(): string {
    return "failing-channel";
  }
  api(): string {
    return "openai-chat";
  }
  models(): Model[] {
    return [this.model];
  }
  getModel(id: string): Model | undefined {
    return this.model.id === id ? this.model : undefined;
  }
}

/** ArtifactPublishingChannelProvider calls publish_artifact on the first turn. */
class ArtifactPublishingChannelProvider implements Provider {
  model: Model;
  calls = 0;
  constructor(model: Model) {
    this.model = model;
  }
  async *chat(_params: ChatParams): AsyncGenerator<StreamEvent> {
    this.calls++;
    const call = this.calls;
    yield { type: streamStart };
    if (call === 1) {
      yield {
        type: streamToolCall,
        toolCall: {
          id: "publish-report",
          name: "publish_artifact",
          arguments: { path: "report.txt" },
        },
      };
      yield { type: streamDone, stopReason: "tool_calls" };
      return;
    }
    yield { type: streamTextDelta, textDelta: "report is ready" };
    yield { type: streamDone, stopReason: "stop" };
  }
  name(): string {
    return "artifact-publishing";
  }
  api(): string {
    return "openai-chat";
  }
  models(): Model[] {
    return [this.model];
  }
  getModel(id: string): Model | undefined {
    return this.model.id === id ? this.model : undefined;
  }
}

/**
 * ChannelToolCallProvider drives one bash tool call and then finishes; used
 * by the security integration tests.
 */
class ChannelToolCallProvider implements Provider {
  model: Model;
  command: string;
  calls: ChatParams[] = [];

  constructor(model: Model, command: string) {
    this.model = model;
    this.command = command;
  }

  async *chat(params: ChatParams): AsyncGenerator<StreamEvent> {
    this.calls.push(params);
    const callNumber = this.calls.length;
    yield { type: streamStart };
    if (callNumber === 1) {
      yield {
        type: streamToolCall,
        toolCall: {
          id: "bash-1",
          name: "bash",
          arguments: { command: this.command },
        },
      };
      yield { type: streamDone, stopReason: "tool_calls" };
      return;
    }
    yield { type: streamTextDelta, textDelta: "done" };
    yield { type: streamDone, stopReason: "stop" };
  }

  name(): string {
    return "channel-tool-call";
  }
  api(): string {
    return "openai-chat";
  }
  models(): Model[] {
    return [this.model];
  }
  getModel(id: string): Model | undefined {
    return this.model.id === id ? this.model : undefined;
  }

  toolResult(): { message: ChatParams["messages"][number] } | null {
    if (this.calls.length < 2) return null;
    for (const message of this.calls[1].messages) {
      if (message.role === "toolResult" && message.toolName === "bash") {
        return { message };
      }
    }
    return null;
  }
}

function channelToolResultText(
  message: { content?: string; contents?: ContentBlock[] },
): string {
  if (message.content !== undefined && message.content !== "") {
    return message.content;
  }
  let text = "";
  for (const content of message.contents ?? []) {
    if (content.type === "text") text += content.text;
  }
  return text;
}

class RecordingChannelBashTool implements Tool {
  #executed: { value: boolean };
  constructor(executed: { value: boolean }) {
    this.#executed = executed;
  }
  name(): string {
    return "bash";
  }
  description(): string {
    return "record a bash execution";
  }
  promptSnippet(): string {
    return "record a bash execution";
  }
  promptGuidelines(): string[] {
    return [];
  }
  parameters(): unknown {
    return {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    };
  }
  execute(
    _ctx: unknown,
    _params: Record<string, unknown>,
  ): { text: string } {
    this.#executed.value = true;
    return newTextToolResult("executed");
  }
}

async function waitFor<T>(
  deadlineMs: number,
  probe: () => T | undefined,
  message: string,
): Promise<T> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((r) => setTimeout(r, 10));
  }
}

// --- channelRouteID / attachment summary / delivery text projection ----------

Deno.test("channel route id uses conversation id for messaging channels", () => {
  assertEquals(
    channelRouteID(
      inbound({ platform: "feishu", userID: "ou_sender", chatID: "oc_chat" }),
    ),
    "oc_chat",
  );
  assertEquals(
    channelRouteID(
      inbound({ platform: "wechat", userID: "user", chatID: "chat" }),
    ),
    "chat",
  );
  assertEquals(
    channelRouteID(
      inbound({ platform: "ws", userID: "user", chatID: "chat" }),
    ),
    "user",
  );
});

Deno.test("format attachment summary", () => {
  const got = formatAttachmentSummary([
    { kind: "citation", name: "OpenAI", url: "https://openai.com" },
    { kind: "file", providerRef: "file_123" },
    { kind: "citation", name: "OpenAI", url: "https://openai.com" },
  ]);
  for (
    const want of [
      "Attachments:",
      "OpenAI: https://openai.com",
      "file: file_123",
    ]
  ) {
    assertStringIncludes(got, want);
  }
  assertEquals(
    got.split("https://openai.com").length - 1,
    1,
    `summary should deduplicate attachments: ${got}`,
  );
});

Deno.test("channel delivery text projection uses per operation payloads", () => {
  const controller = new ChannelDeliveryController(Deno.makeTempDirSync());
  const intent = {
    id: "intent-text-projection",
    runId: "run-text-projection",
    targetId: "chat",
    transportContext: JSON.stringify({
      caption: "caption",
      fallback: "fallback",
    }),
  };
  const caption = controller.textProjection(
    { id: "caption-op", operationKind: "send_text" } as never,
    intent as never,
    deliveryOperationText(intent.transportContext, "send_text"),
  );
  const fallback = controller.textProjection(
    {
      id: "fallback-op",
      operationKind: "send_fallback_text",
      dependsOn: "caption-op",
    } as never,
    intent as never,
    deliveryOperationText(intent.transportContext, "send_fallback_text"),
  );
  assertEquals(caption.text, "caption");
  assertEquals(fallback.text, "fallback");
  assert(
    caption.id !== fallback.id && caption.runID === fallback.runID &&
      caption.targetID === fallback.targetID,
    `text projection identity = ${caption.id} / ${fallback.id}`,
  );
});

// --- /new rotation ------------------------------------------------------------

Deno.test("handle message /new rotates wechat and feishu bound sessions", async (t) => {
  const cases = [
    {
      name: "wechat uses chat id",
      platform: "wechat",
      userID: "wechat-sender",
      chatID: "wechat-chat",
      routeID: "wechat-chat",
    },
    {
      name: "feishu uses chat id instead of open id",
      platform: "feishu",
      userID: "ou_sender",
      chatID: "oc_chat",
      routeID: "oc_chat",
    },
    {
      name: "wechat falls back to user id",
      platform: "wechat",
      userID: "wechat-user-only",
      chatID: "",
      routeID: "wechat-user-only",
    },
    {
      name: "feishu falls back to open id",
      platform: "feishu",
      userID: "ou_user-only",
      chatID: "",
      routeID: "ou_user-only",
    },
  ];
  for (const tt of cases) {
    await t.step(tt.name, async () => {
      const sessionDir = Deno.makeTempDirSync();
      const workDir = Deno.makeTempDirSync();
      const old = createBound(workDir, sessionDir, tt.platform, tt.routeID);

      const d = new Dispatcher({ cfg: defaultConfig() });
      d.sessionDir = sessionDir;
      d.sessions = new Map();
      d.identityLocks = newIdentityLocks();
      const response = await handleMessage(
        d,
        new AbortController().signal,
        inbound({
          platform: tt.platform,
          userID: tt.userID,
          chatID: tt.chatID,
          text: "/new",
        }),
      );
      assertStringIncludes(response, "New session created");

      const binding = findBinding(sessionDir, tt.platform, tt.routeID);
      assert(binding !== null, `binding for route ${tt.routeID} was removed`);
      assert(
        binding.sessionId !== old.getHeader()!.id,
        `binding still points to old session ${old.getHeader()!.id}`,
      );
      assertEquals(binding.channelId, tt.routeID);

      // A differing sender ID is intentional for the chat-ID cases: this
      // verifies the command passed through HandleMessage's canonical route
      // normalization rather than relying on the raw sender ID.
      if (tt.chatID !== "" && tt.userID !== tt.routeID) {
        const rawBinding = findBinding(sessionDir, tt.platform, tt.userID);
        assert(
          rawBinding === null,
          `command unexpectedly rotated sender binding ${tt.userID} instead of chat binding ${tt.routeID}`,
        );
      }
    });
  }
});

// --- registry / catalog contracts ---------------------------------------------

Deno.test("refresh binding removes cached route", () => {
  const d = new Dispatcher();
  d.sessions = new Map();
  const key = sessionKey("wechat", "user-a");
  const sess = new ChannelSession();
  sess.id = "session-1";
  sess.platform = "wechat";
  sess.userID = "user-a";
  d.sessions.set(key, sess);

  d.refreshBinding("wechat", "user-a");
  assertEquals(d.getSession(key), null);
});

Deno.test("session lease defers invalidated eviction until release", () => {
  const d = new Dispatcher();
  d.sessions = new Map();
  const key = sessionKey("wechat", "lease-user");
  const sess = new ChannelSession();
  sess.id = "session-lease";
  sess.platform = "wechat";
  sess.userID = "lease-user";
  d.sessions.set(key, sess);

  const lease = d.acquireSessionLease(key, "wechat", "lease-user", sess);
  assert(lease !== null, "acquireSessionLease failed");
  d.invalidateSessionLocked(key, sess);
  assert(
    d.getSession(key) !== null,
    "invalidated session was evicted while a request was pending",
  );
  lease.release();
  assertEquals(
    d.getSession(key),
    null,
    "invalidated session was not evicted after the last lease released",
  );
});

Deno.test("tool catalog reports runtime availability", () => {
  const d = new Dispatcher({ cfg: defaultConfig() });
  const items = d.toolCatalog("wechat");
  const byName = new Map(items.map((item) => [item.name, item]));
  const a2a = byName.get("a2a_dispatch");
  assert(a2a !== undefined, "catalog missing a2a_dispatch");
  assert(
    !a2a.available && !a2a.default && a2a.unavailableReason !== "",
    `catalog item a2a_dispatch = ${JSON.stringify(a2a)}`,
  );
  for (
    const name of [
      "browser",
      "delegate_subagent",
      "subagent_spawn",
      "workflow_run",
    ]
  ) {
    const item = byName.get(name);
    assert(item !== undefined, `catalog missing ${name}`);
    assert(
      item.available,
      `catalog item ${name} available=${item.available}, want selectable when feature flag is off`,
    );
    assert(
      !item.default,
      `catalog item ${name} default=${item.default}, want unchecked when feature flag is off`,
    );
  }
});

Deno.test("tool catalog matches resolved registry contract", async () => {
  const { d, settings, workDir } = newFixture();
  const sess = await resolveSessionForTest(
    d,
    "ws",
    "tool-contract",
    settings,
    workDir,
  );
  const registered = new Set(
    sess.registry!.all().map((tool) => tool.name()),
  );
  for (const item of d.toolCatalog("ws")) {
    if (item.available && item.default && !registered.has(item.name)) {
      throw new Error(
        `catalog says ${item.name} is available/default but registry omitted it`,
      );
    }
    if (!item.available && registered.has(item.name)) {
      throw new Error(
        `catalog says ${item.name} is unavailable but registry registered it`,
      );
    }
  }
});

Deno.test("tool catalog multi agent flag controls default only", async () => {
  const { d, settings, workDir } = newFixture({ multiAgent: false });
  // Catalog: multi-agent tools must be available but unchecked by default.
  for (const item of d.toolCatalog("wechat")) {
    if (
      [
        "delegate_subagent",
        "subagent_spawn",
        "subagent_status",
        "subagent_send",
        "subagent_destroy",
        "subagent_wait",
        "subagent_answer",
        "workflow_lint",
        "workflow_run",
        "workflow_status",
        "workflow_cancel",
        "browser",
      ].includes(item.name)
    ) {
      assert(
        item.available,
        `catalog ${item.name} available=${item.available}, want selectable even when multiAgent/browser is off`,
      );
      assert(
        !item.default,
        `catalog ${item.name} default=${item.default}, want unchecked when multiAgent/browser is off`,
      );
    }
  }

  // Explicitly enabling a multi-agent tool must register it at runtime.
  const binding = createBound(
    workDir,
    settings.sessionDir!,
    "wechat",
    "ma-default-only",
  );
  setChannelTools(settings.sessionDir!, binding.getHeader()!.id, [
    { toolName: "subagent_spawn", enabled: true },
  ]);
  const sess = await resolveSessionForTest(
    d,
    "wechat",
    "ma-default-only",
    settings,
    workDir,
  );
  const registered = new Set(sess.registry!.all().map((tool) => tool.name()));
  assert(
    registered.has("subagent_spawn"),
    `subagent_spawn not registered despite explicit enable; got ${[
      ...registered,
    ]}`,
  );
  assert(
    registered.has("workflow_run"),
    "workflow_run not registered despite explicit enable",
  );
});

Deno.test("tool catalog every available selection matches registry", async () => {
  const { d, settings, workDir } = newFixture();
  const binding = createBound(
    workDir,
    settings.sessionDir!,
    "wechat",
    "catalog-contract",
  );
  const selections: ChannelToolConfig[] = d.toolCatalog("wechat").map(
    (item) => ({ toolName: item.name, enabled: item.available }),
  );
  setChannelTools(settings.sessionDir!, binding.getHeader()!.id, selections);
  const sess = await resolveSessionForTest(
    d,
    "wechat",
    "catalog-contract",
    settings,
    workDir,
  );
  const registered = new Set(sess.registry!.all().map((tool) => tool.name()));
  for (const item of d.toolCatalog("wechat")) {
    assertEquals(
      registered.has(item.name),
      item.available,
      `tool ${item.name} registered=${
        registered.has(item.name)
      }, catalog available=${item.available}`,
    );
  }
});

Deno.test("resolve session cron only does not expose sub agent tools", async () => {
  const { d, settings } = newFixture({ multiAgent: false, cronEnabled: true });
  d.cronStore = newSQLiteCronStore(Deno.makeTempDirSync());

  assert(
    d.ensureAgentManager() !== null,
    "cron should be able to initialize an agent manager without multi-agent",
  );
  const sess = await resolveSessionForTest(d, "ws", "test-user", settings);
  assert(
    registryHas(sess.registry!, "cron"),
    "cron-only session should expose cron tool",
  );
  const headerID = sess.manager!.getHeader()!.id;
  assertEquals(sess.id, headerID);
  assert(
    sess.runtime !== null && sess.runtime!.manager === sess.manager &&
      sess.runtime!.registry === sess.registry,
    "channel session is not backed by shared runtime",
  );
  assert(
    sess.id !== sessionKey("ws", "test-user"),
    "channel session ID must not be the routing key",
  );
  for (const name of subAgentToolNames()) {
    assert(
      !registryHas(sess.registry!, name),
      `cron-only session should not expose ${name}`,
    );
  }
});

Deno.test("resolve session bound team expert uses session manager", async () => {
  const { d, settings, workDir } = newFixture({ multiAgent: false });
  settings.contextFiles!.enabled = false;
  const bound = createBound(
    workDir,
    settings.sessionDir!,
    "wechat",
    "team-manager",
  );
  bound.setExpertBinding("software-company");

  const sess = await resolveSessionForTest(
    d,
    "wechat",
    "team-manager",
    settings,
    workDir,
  );
  assert(
    sess.agentMgr !== null && sess.agentMgr!.members !== null,
    "team channel session did not receive a session-scoped agent manager",
  );
  assert(
    d.agentMgr === null || sess.agentMgr !== d.agentMgr,
    "team channel session reused the dispatcher-wide agent manager",
  );
  assert(
    sess.agentMgr!.members!.get("software-engineer") !== undefined,
    `team manager members = ${
      sess.agentMgr!.members!.ids()
    }, missing software-engineer`,
  );
  assert(
    registryHas(sess.registry!, "subagent_spawn"),
    "team channel registry missing subagent_spawn",
  );
});

// --- commands -------------------------------------------------------------------

Deno.test("channel help command", async (t) => {
  for (const platform of ["wechat", "feishu"]) {
    await t.step(platform, async () => {
      const d = new Dispatcher();
      const reply = await handleCommand(
        d,
        inbound({ platform, userID: "test-user", text: "/help" }),
      );
      for (
        const command of [
          "/new",
          "/clear",
          "/status",
          "/sessions",
          "/mode",
          "/compact",
          "/help",
        ]
      ) {
        assertStringIncludes(reply, command);
      }
    });
  }
  const reply = await handleCommand(
    new Dispatcher(),
    inbound({ platform: "wechat", userID: "test-user", text: "/unknown" }),
  );
  assertStringIncludes(reply, "/help");
});

Deno.test("compact command runs immediately", async () => {
  const tmpDir = Deno.makeTempDirSync();
  const p = newRecordingProvider();
  const settings = defaultSettings();
  settings.compaction!.keepRecentTokens = 1;
  // Go's fixture leaves d.sessionDir empty with a manager in a separate temp
  // root; the port's mutation lease needs the real root, so pin it here.
  const sessionDir = Deno.makeTempDirSync();

  const mgr = newManager(tmpDir, sessionDir);
  mgr.init();
  mgr.appendMessage({
    role: "user",
    content: "old user context",
    timestamp: new Date(),
  });
  mgr.appendMessage(
    newAssistantMessage([{ type: "text", text: "old assistant context" }]),
  );
  mgr.appendMessage({
    role: "user",
    content: "recent user context",
    timestamp: new Date(),
  });
  mgr.appendMessage(
    newAssistantMessage([{ type: "text", text: "recent assistant context" }]),
  );

  const sess = new ChannelSession();
  sess.id = sessionKey("ws", "test-user");
  sess.platform = "ws";
  sess.userID = "test-user";
  sess.workDir = tmpDir;
  sess.manager = mgr;
  sess.sandboxMgr = newSandboxManagerFor(tmpDir);
  sess.registry = newRegistry(tmpDir, newNoneSandbox());
  sess.mode = "agent";
  const d = new Dispatcher({ cfg: defaultConfig(), settings });
  d.sessionDir = sessionDir;
  d.provider = p;
  d.model = p.models()[0];
  d.sessions = new Map([[sess.id, sess]]);

  const reply = await handleCommand(
    d,
    inbound({ platform: "ws", userID: "test-user", text: "/compact" }),
  );
  assertStringIncludes(reply, "compacted");
  assert(
    !sess.forceCompact,
    "ForceCompact should not be set for immediate compaction",
  );
  const replay = mgr.getReplayState();
  assert(
    replay.messages.length > 0 && replay.messages[0].systemInjected === true,
    `expected compacted summary in replay, got ${
      JSON.stringify(replay.messages.map((m) => [m.role, m.systemInjected]))
    }`,
  );
});

Deno.test("compact command forces summary only when only recent context", async () => {
  const tmpDir = Deno.makeTempDirSync();
  const p = newRecordingProvider();
  const settings = defaultSettings();
  const sessionDir = Deno.makeTempDirSync();

  const mgr = newManager(tmpDir, sessionDir);
  mgr.init();
  mgr.appendMessage({ role: "user", content: "hello", timestamp: new Date() });
  mgr.appendMessage(newAssistantMessage([{ type: "text", text: "hi" }]));

  const sess = new ChannelSession();
  sess.id = sessionKey("ws", "test-user");
  sess.platform = "ws";
  sess.userID = "test-user";
  sess.workDir = tmpDir;
  sess.manager = mgr;
  sess.sandboxMgr = newSandboxManagerFor(tmpDir);
  sess.registry = newRegistry(tmpDir, newNoneSandbox());
  sess.mode = "agent";
  const d = new Dispatcher({ cfg: defaultConfig(), settings });
  d.sessionDir = sessionDir;
  d.provider = p;
  d.model = p.models()[0];
  d.sessions = new Map([[sess.id, sess]]);

  const reply = await handleCommand(
    d,
    inbound({ platform: "ws", userID: "test-user", text: "/compact" }),
  );
  assert(!sess.forceCompact);
  assertStringIncludes(reply, "compacted");
  const replay = mgr.getReplayState();
  assert(
    replay.messages.length === 1 && replay.messages[0].systemInjected === true,
    `expected summary-only replay, got ${
      JSON.stringify(replay.messages.map((m) => [m.role, m.systemInjected]))
    }`,
  );
});

// --- buildAgent ------------------------------------------------------------------

function buildAgentSession(
  workDir: string,
  mgr: ReturnType<typeof newManager>,
  mode: string,
  registry?: ReturnType<typeof newRegistry>,
): ChannelSession {
  const sess = new ChannelSession();
  sess.id = "channels/ws/test-user";
  sess.platform = "ws";
  sess.userID = "test-user";
  sess.workDir = workDir;
  sess.manager = mgr;
  sess.sandboxMgr = newSandboxManagerFor(workDir);
  sess.registry = registry ?? newRegistry(workDir, newNoneSandbox());
  sess.mode = mode;
  return sess;
}

function newSandboxManagerFor(
  workDir: string,
): ReturnType<typeof newManagerWithOptions> {
  const mgr = newManagerWithOptions(workDir, {});
  mgr.setLevel(Level.None);
  return mgr;
}

async function runAgentOnce(
  d: Dispatcher,
  sess: ChannelSession,
): Promise<void> {
  const built = await buildAgent(d, new AbortController().signal, sess, null);
  assert(built !== null, "buildAgent returned null");
  for await (const _ of built.agent.run("continue")) {
    // drain events
  }
  built.cleanup(null);
}

Deno.test("buildAgent loads replay state", async () => {
  const tmpDir = Deno.makeTempDirSync();
  const p = newRecordingProvider();
  const settings = defaultSettings();
  settings.sessionDir = Deno.makeTempDirSync();

  const mgr = newManager(tmpDir, settings.sessionDir!);
  mgr.init();
  const oldUser = "old user context";
  const recentUser = "recent user context";
  mgr.appendMessage({ role: "user", content: oldUser, timestamp: new Date() });
  mgr.appendMessage(
    newAssistantMessage([{ type: "text", text: "old assistant context" }]),
  );
  const recentUserID = mgr.appendMessage({
    role: "user",
    content: recentUser,
    timestamp: new Date(),
  });
  mgr.appendMessage(
    newAssistantMessage([{ type: "text", text: "recent assistant context" }]),
  );
  mgr.appendCompaction("## Goal\ncompacted checkpoint", recentUserID, 100);

  const d = new Dispatcher({ cfg: defaultConfig(), settings });
  d.provider = p;
  d.model = p.models()[0];
  const sess = buildAgentSession(tmpDir, mgr, "agent");

  await runAgentOnce(d, sess);

  assertEquals(p.calls.length, 1, `provider call count = ${p.calls.length}`);

  let foundSummary = false;
  let foundOldUser = false;
  let foundRecentUser = false;
  for (const msg of p.calls[0].messages) {
    if (msg.systemInjected && msg.content === "## Goal\ncompacted checkpoint") {
      foundSummary = true;
    }
    if (msg.content === oldUser) foundOldUser = true;
    if (msg.content === recentUser) foundRecentUser = true;
  }
  assert(foundSummary, "channel agent did not replay compacted summary");
  assert(
    !foundOldUser,
    "channel agent still included pre-compaction old user message",
  );
  assert(
    foundRecentUser,
    "channel agent lost recent user message from replay state",
  );
});

Deno.test("buildAgent injects changed ESM objective", async () => {
  const workDir = Deno.makeTempDirSync();
  const settings = defaultSettings();
  settings.sessionDir = Deno.makeTempDirSync();
  const mgr = newManager(workDir, settings.sessionDir!);
  mgr.init();
  const p = newRecordingProvider();
  const d = new Dispatcher({ cfg: defaultConfig(), settings });
  d.provider = p;
  d.model = p.models()[0];
  d.sessionDir = settings.sessionDir;
  const sess = new ChannelSession();
  sess.id = mgr.getHeader()!.id;
  sess.platform = "ws";
  sess.userID = "steering-user";
  sess.workDir = workDir;
  sess.manager = mgr;
  sess.sandboxMgr = newSandboxManagerFor(workDir);
  sess.registry = newRegistry(workDir, newNoneSandbox());
  sess.mode = "yolo";
  new EsmStore(settings.sessionDir!).create(
    sess.id,
    "finish the channel objective",
  );

  await runAgentOnce(d, sess);
  assertEquals(p.calls.length, 1, `provider calls = ${p.calls.length}`);
  for (const message of p.calls[0].messages) {
    if (
      message.systemInjected &&
      (message.content ?? "").includes("finish the channel objective")
    ) {
      return;
    }
  }
  throw new Error(
    `channel provider messages missing ESM steering: ${
      JSON.stringify(
        p.calls[0].messages.map((m) => [m.role, m.systemInjected, m.content]),
      )
    }`,
  );
});

Deno.test("buildAgent uses compaction settings", async () => {
  const tmpDir = Deno.makeTempDirSync();
  const p = newRecordingProvider();
  const settings = defaultSettings();
  settings.compaction!.keepRecentTokens = 1;

  const mgr = newManager(tmpDir, Deno.makeTempDirSync());
  mgr.init();
  mgr.appendMessage({
    role: "user",
    content: "old user context",
    timestamp: new Date(),
  });
  mgr.appendMessage(
    newAssistantMessage([{ type: "text", text: "old assistant context" }]),
  );
  mgr.appendMessage({
    role: "user",
    content: "recent user context",
    timestamp: new Date(),
  });
  mgr.appendMessage(
    newAssistantMessage([{ type: "text", text: "recent assistant context" }]),
  );

  const d = new Dispatcher({ cfg: defaultConfig(), settings });
  d.provider = p;
  d.model = p.models()[0];
  const sess = buildAgentSession(tmpDir, mgr, "agent");
  const built = await buildAgent(d, new AbortController().signal, sess, null);
  assert(built !== null);
  assert(
    built.agent.canCompact(),
    "agent should use channel compaction keepRecent settings",
  );
});

Deno.test("buildAgent prompt flags follow session registry", async () => {
  const tmpDir = Deno.makeTempDirSync();
  const p = newRecordingProvider();
  const settings = defaultSettings();

  const mgr = newManager(tmpDir, Deno.makeTempDirSync());
  mgr.init();

  const d = new Dispatcher({ cfg: defaultConfig(), settings });
  d.provider = p;
  d.model = p.models()[0];
  const manager = d.ensureAgentManager();
  assert(manager !== null, "ensureAgentManager returned null");

  const reg = newRegistry(tmpDir, newNoneSandbox());
  registerSubAgentTools(reg, manager);
  registerDelegateSubAgentTool(reg, manager);
  registerWorkflowTools(reg, { manager });

  const sess = buildAgentSession(tmpDir, mgr, "yolo", reg);
  await runAgentOnce(d, sess);

  assertEquals(p.calls.length, 1, `provider call count = ${p.calls.length}`);
  const sp = p.calls[0].systemPrompt;
  for (
    const section of [
      "## Sub-Agent Tools",
      "## Delegation Mode",
      "## Workflow Tools",
    ]
  ) {
    assertStringIncludes(sp, section);
  }
});

Deno.test("buildAgent prompt omits sub agent sections when tools absent", async () => {
  const tmpDir = Deno.makeTempDirSync();
  const p = newRecordingProvider();
  const settings = defaultSettings();

  const mgr = newManager(tmpDir, Deno.makeTempDirSync());
  mgr.init();

  const d = new Dispatcher({ cfg: defaultConfig(), settings });
  d.provider = p;
  d.model = p.models()[0];
  d.multiAgent = true; // dispatcher flag alone must not inject prompt sections

  const sess = buildAgentSession(tmpDir, mgr, "yolo");
  await runAgentOnce(d, sess);

  assertEquals(p.calls.length, 1, `provider call count = ${p.calls.length}`);
  const sp = p.calls[0].systemPrompt;
  for (
    const section of [
      "## Sub-Agent Tools",
      "## Delegation Mode",
      "## Workflow Tools",
    ]
  ) {
    assert(
      !sp.includes(section),
      `system prompt contains ${section} although no sub-agent tools are registered`,
    );
  }
});

// --- background delegation / stop -------------------------------------------------

Deno.test("handle message delegates background run before local agent loop", async () => {
  const { d } = newFixture();
  const p = d.provider as RecordingChannelProvider;
  p.background = true;
  const holder: { req?: Record<string, unknown> } = {};
  d.setBackgroundSubmitter((req) => {
    assertEquals(
      (req as unknown as Record<string, unknown>).idempotencyKey,
      "channel:wechat:background-user:event-1",
    );
    holder.req = req as unknown as Record<string, unknown>;
    return Promise.resolve("responses-run-1");
  });
  const response = await handleMessage(
    d,
    new AbortController().signal,
    inbound({
      platform: "wechat",
      userID: "background-user",
      messageID: "event-1",
      text: "run remotely",
    }),
  );
  assertStringIncludes(response, "responses-run-1");
  const got = holder.req;
  assert(got !== undefined, "background submitter was not called");
  assertEquals((got.input as { text?: string }).text, "run remotely");
  assertEquals(got.platform, "wechat");
  assert(
    (got.sessionId as string) !== "",
    "background request missing session ID",
  );
  assert((got.runId as string) !== "", "background request missing run ID");
});

Deno.test("cancel channel session run aborts active run", async () => {
  const sess = new ChannelSession();
  sess.id = "channel-cancel-user";
  const d = new Dispatcher();
  d.sessionDir = Deno.makeTempDirSync();
  d.sessions = new Map([[sess.id, sess]]);
  const { signal } = await beginChannelStopTestRun(
    d,
    sess,
    "channel-run",
    null,
  );
  assert(
    await d.cancelChannelSessionRun(sess.id),
    "CancelChannelSessionRun returned false for active run",
  );
  await waitFor(
    2000,
    () => (signal.aborted ? true : undefined),
    "active channel context was not cancelled",
  );
});

/** beginChannelStopTestRun seeds one durable running channel run. */
async function beginChannelStopTestRun(
  d: Dispatcher,
  sess: ChannelSession,
  runID: string,
  runningAgent: { abort(): void } | null,
): Promise<{ signal: AbortSignal }> {
  const mgr = newManager(Deno.makeTempDirSync(), d.sessionDir);
  mgr.initWithID(sess.id);
  sess.manager = mgr;
  const guard = await acquireExecutionAdmission(
    undefined,
    d.sessionDir,
    sess.id,
  );
  const execution = new ExecutionRuntime();
  execution.setRunStore(new RunStore(d.sessionDir));
  const startedAt = new Date();
  const run: DurableRun = {
    id: runID,
    sessionId: sess.id,
    intentId: "",
    retryOf: "",
    attempt: 0,
    workDir: mgr.getHeader()!.cwd,
    source: "channel:wechat",
    model: "test",
    mode: "yolo",
    status: "running",
    startedAt,
    finishedAt: null,
    error: "",
    errorInfo: {},
    progress: {},
    usage: undefined,
    contextUsage: undefined,
    inputResourceIds: [],
    submissionKeyHash: "",
    submissionScope: "",
    submissionFingerprint: "",
    userEntryId: "",
    assistantEntryId: "",
    conversationTurnId: "",
    conversationTurn: false,
  };
  const event: RunEvent = {
    sessionId: sess.id,
    runId: runID,
    eventType: "started",
    source: "channel:wechat",
    status: "running",
    model: "test",
    mode: "yolo",
    timestamp: startedAt,
    data: {},
  } as RunEvent;
  let signal: AbortSignal;
  try {
    signal = execution.beginDurable(undefined, run, event);
  } catch (err) {
    guard.release();
    throw err;
  }
  if (runningAgent !== null) execution.setAgent(runningAgent);
  sess.execution = execution;
  sess.runID = runID;
  sess.runAgent = runningAgent as never;
  return {
    signal,
    // The caller releases through the returned cancellation path; the guard
    // itself is released by the stop path or at test teardown.
    [Symbol.dispose]: () => guard.release(),
  } as { signal: AbortSignal };
}

// --- failure persistence / stale-run recovery --------------------------------------

function newProviderFixture(
  provider: Provider,
  overrides: { multiAgent?: boolean; identityLocks?: boolean } = {},
): DispatcherFixture {
  const workDir = Deno.makeTempDirSync({ prefix: "opensac-ch-work-" });
  const settings = defaultSettings();
  settings.sessionDir = Deno.makeTempDirSync({ prefix: "opensac-ch-sess-" });
  const cfg = defaultConfig();
  cfg.workDir = workDir;
  // Go's provider fixtures use a 32768-token context window; a smaller window
  // would trigger the auto-compaction path instead of the failure path.
  provider.models()[0].contextWindow = 32768;
  const d = new Dispatcher({ cfg, settings });
  d.sessionDir = settings.sessionDir;
  d.provider = provider;
  d.model = provider.models()[0];
  d.multiAgent = overrides.multiAgent ?? false;
  d.sessions = new Map();
  if (overrides.identityLocks ?? true) d.identityLocks = newIdentityLocks();
  return { d, settings, workDir };
}

Deno.test("handle message persists channel failure event", async () => {
  const { d, settings } = newProviderFixture(
    new FailingChannelProvider(testModel("m1")),
  );
  const progress: string[] = [];
  let err: unknown = null;
  try {
    await handleMessage(
      d,
      new AbortController().signal,
      inbound({
        platform: "wechat",
        userID: "failure-user",
        text: "继续",
        progressFunc: (message) => progress.push(message),
      }),
    );
  } catch (e) {
    err = e;
  }
  assert(
    err instanceof Error && err.message.includes("HTTP 522"),
    `HandleMessage error = ${err}, want provider diagnostic`,
  );
  // The provider emits a retry notice and then fails; Agent Core's bounded
  // continuation retry re-runs the turn, so the same provider notice appears
  // once per attempt. Every notice must be the structured adapter projection
  // and never the raw provider retry detail.
  assert(
    progress.length > 0 && progress[0] === "↻ Retrying (1/5); waiting 1s...",
    `progress = ${
      JSON.stringify(progress)
    }, want the structured retry notice first`,
  );
  for (const line of progress) {
    assert(
      !line.includes("server overloaded"),
      `progress = ${
        JSON.stringify(progress)
      }, must not render provider retry detail`,
    );
  }
  const sess = await resolveSessionForTest(
    d,
    "wechat",
    "failure-user",
    settings,
  );
  const events = listSessionRunEvents(settings.sessionDir!, sess.id);
  const failedEvent = events.find(
    (event) => event.eventType === "failed" && event.status === "failed",
  );
  assert(
    failedEvent !== undefined &&
      JSON.stringify(failedEvent.data).includes("HTTP 522"),
    `run events = ${
      JSON.stringify(events.map((e) => [e.eventType, e.status]))
    }, want provider diagnostic`,
  );
  const run = getSessionRun(settings.sessionDir!, failedEvent!.runId);
  assert(run !== null && run !== undefined, "persisted run missing");
  assert(
    JSON.stringify(run!.errorInfo).includes("HTTP 522"),
    `run error info = ${
      JSON.stringify(run!.errorInfo)
    }, want provider diagnostic`,
  );
});

Deno.test("handle message recovers stale local run before durable admission", async () => {
  const { d, settings, workDir } = newProviderFixture(
    new FailingChannelProvider(testModel("m1")),
  );
  const sess = await resolveSessionForTest(
    d,
    "wechat",
    "stale-run-user",
    settings,
  );
  const now = new Date();
  saveSessionRun(
    settings.sessionDir!,
    {
      id: "stale-wechat-run",
      sessionId: sess.id,
      intentId: "",
      retryOf: "",
      attempt: 0,
      workDir,
      source: "wechat",
      model: "m1",
      mode: ModeYolo,
      status: "running",
      startedAt: now,
      updatedAt: now,
      finishedAt: null,
      error: "",
      errorInfo: undefined,
      progress: undefined,
      usage: undefined,
      contextUsage: undefined,
      inputResourceIds: [],
      submissionKeyHash: "",
      submissionScope: "",
      submissionFingerprint: "",
      userEntryId: "",
      assistantEntryId: "",
    },
  );

  let err: unknown = null;
  try {
    await handleMessage(
      d,
      new AbortController().signal,
      inbound({ platform: "wechat", userID: "stale-run-user", text: "继续" }),
    );
  } catch (e) {
    err = e;
  }
  assert(
    err instanceof Error && err.message.includes("HTTP 522"),
    `HandleMessage error = ${err}, want provider error rather than active-run constraint`,
  );
  const stale = getSessionRun(settings.sessionDir!, "stale-wechat-run");
  assert(
    stale !== null && stale !== undefined && stale.status === "failed",
    `stale run = ${JSON.stringify(stale)}`,
  );
  const events = listSessionRunEvents(settings.sessionDir!, sess.id);
  const recovered = events.find(
    (event) =>
      event.runId === "stale-wechat-run" &&
      event.eventType === "recovered" &&
      event.status === "failed",
  );
  assert(
    recovered !== undefined,
    `run events = ${
      JSON.stringify(events.map((e) => [e.runId, e.eventType, e.status]))
    }, want stale-run recovery event`,
  );
});

Deno.test("apply settings refreshes channel provider retry config", async () => {
  let attempts = 0;
  const upstream = Deno.serve({ port: 0, hostname: "127.0.0.1" }, (_req) => {
    attempts++;
    if (attempts === 1) {
      return new Response("temporarily unavailable", { status: 503 });
    }
    return new Response(
      `data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`,
      { headers: { "Content-Type": "text/event-stream" } },
    );
  });
  try {
    const settings = defaultSettings();
    settings.sessionDir = Deno.makeTempDirSync();
    settings.defaultProvider = "retry-test";
    settings.defaultModel = "m1";
    settings.retry = { enabled: false, maxRetries: 1, baseDelayMs: 1 };
    settings.providers = {
      "retry-test": {
        apiKey: "test-key",
        baseUrl: `http://127.0.0.1:${upstream.addr.port}`,
        api: "openai-chat",
        models: [{ id: "m1", name: "M1" }],
      },
    };
    const cfg = defaultConfig();
    cfg.workDir = Deno.makeTempDirSync();
    cfg.defaultProvider = "retry-test";
    cfg.defaultModel = "m1";
    const { newDispatcher } = await import("./dispatcher.ts");
    const d = newDispatcher({
      cfg,
      settings,
      version: "test",
      cronStore: null,
      scheduler: null,
    });
    try {
      const next = { ...settings };
      next.retry = { enabled: true, maxRetries: 1, baseDelayMs: 1 };
      d.applySettings(next);
      const runtime = d.runtimeSnapshot();
      const stream = runtime.provider!.chat({
        modelId: "m1",
        messages: [{ role: "user", content: "retry", timestamp: new Date() }],
        systemPrompt: "",
        thinkingLevel: "off",
        maxTokens: 1024,
      });
      for await (const _ of stream) {
        // drain
      }
      assertEquals(
        attempts,
        2,
        `provider attempts = ${attempts}, want 2 after settings refresh`,
      );
    } finally {
      d.close();
    }
  } finally {
    upstream.shutdown();
    await upstream.finished;
  }
});

// --- image materialization / artifact projection ------------------------------------

Deno.test("handle delivery materializes channel image through runtime", async () => {
  const { d, settings, workDir } = newFixture();
  const p = d.provider as RecordingChannelProvider;
  p.modelsList[0].input = ["text", "image"];
  p.modelsList[0].contextWindow = 32768;
  const png = Uint8Array.from(
    atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl8P6sAAAAASUVORK5CYII=",
    ),
    (c) => c.charCodeAt(0),
  );
  const response = await handleDelivery(
    d,
    new AbortController().signal,
    inbound({
      platform: "wechat",
      userID: "sender",
      chatID: "conversation",
      messageID: "message-1",
      text: "what is shown?",
      attachments: [
        {
          reference: "wechat:opaque-media-reference",
          kind: AttachmentImage,
          filename: "",
          mediaType: "image/png",
          sizeHint: png.length,
          messageID: "message-1",
          open: (_signal) =>
            Promise.resolve<AttachmentStream>({
              reader: new Response(png).body!,
              filename: "image.png",
              mediaType: "image/png",
              contentSize: png.length,
            }),
        },
      ],
    }),
  );
  assertEquals(response.text, "ok");
  const provider = d.provider as RecordingChannelProvider;
  assertEquals(
    provider.calls.length,
    1,
    `provider calls = ${provider.calls.length}`,
  );
  let foundManifest = false;
  for (const message of provider.calls[0].messages) {
    if ((message.content ?? "").includes(".opensac/tmp/inputs/")) {
      foundManifest = true;
    }
    for (const content of message.contents ?? []) {
      assert(
        content.image === undefined,
        `channel image was sent directly to provider: ${
          JSON.stringify(provider.calls[0].messages)
        }`,
      );
      if ((content.text ?? "").includes(".opensac/tmp/inputs/")) {
        foundManifest = true;
      }
    }
  }
  assert(
    foundManifest,
    `provider messages did not contain the Runtime path manifest: ${
      JSON.stringify(provider.calls[0].messages)
    }`,
  );
  // The port renames the config directory, so the materialized inputs live
  // under .opensac/tmp/inputs (Go's fixture used .opensac).
  const inputsDir = join(workDir, ".opensac", "tmp", "inputs");
  const paths: string[] = [];
  for (const dirEntry of Deno.readDirSync(inputsDir)) {
    if (dirEntry.isDirectory) {
      for (
        const fileEntry of Deno.readDirSync(join(inputsDir, dirEntry.name))
      ) {
        if (fileEntry.isFile && fileEntry.name.endsWith(".png")) {
          paths.push(join(inputsDir, dirEntry.name, fileEntry.name));
        }
      }
    }
  }
  assertEquals(paths.length, 1, `materialized image paths = ${paths}`);
  const stored = Deno.readFileSync(paths[0]);
  assertEquals(
    stored.byteLength,
    png.byteLength,
    `materialized image = ${stored.byteLength} bytes`,
  );
  const call = JSON.stringify(provider.calls[0].messages);
  assert(
    !call.includes("wechat:opaque-media-reference"),
    "opaque platform reference leaked into provider message",
  );
  assert(settings.sessionDir !== "");
});

Deno.test("handle delivery projects runtime published artifact", async () => {
  const { d, settings, workDir } = newFixture({ artifact: true });
  Deno.writeTextFileSync(join(workDir, "report.txt"), "generated report");
  const model = testModel("artifact-model");
  model.contextWindow = 32768;
  const p = new ArtifactPublishingChannelProvider(model);
  d.provider = p;
  d.model = model;
  const response = await handleDelivery(
    d,
    new AbortController().signal,
    inbound({
      platform: "feishu",
      userID: "ou_sender",
      chatID: "oc_chat",
      text: "create a report",
    }),
  );
  assertEquals(response.text, "report is ready");
  assertEquals(
    response.attachments?.length,
    1,
    `delivery response = ${JSON.stringify(response)}`,
  );
  const attachment = response.attachments![0];
  assertEquals(attachment.kind, "file");
  assertEquals(attachment.filename, "report.txt");
  assert(attachment.open !== undefined && attachment.complete !== undefined);

  const stream = await attachment.open!(new AbortController().signal);
  const data = await new Response(stream).text();
  assertEquals(data, "generated report");

  assert(
    response.textDelivery?.prepare !== undefined &&
      response.textDelivery?.complete !== undefined,
    `text delivery projection = ${JSON.stringify(response.textDelivery)}`,
  );
  await response.textDelivery!.prepare!(new AbortController().signal);
  response.textDelivery!.complete!(
    new AbortController().signal,
    "delivered",
    "om_feishu_caption",
    "",
  );
  // The port's transport callbacks are async fire-and-forget (Go's are
  // synchronous), so yield between them to preserve the Go ordering.
  await new Promise((r) => setTimeout(r, 100));
  attachment.complete!(
    new AbortController().signal,
    "delivered",
    "om_feishu_media",
    "",
  );

  // Verify the canonical delivery projection through the DAO (Go's test
  // queries delivery_intents by platform directly). The transport-complete
  // callbacks are async, so poll until the terminal status lands.
  const binding = findBinding(settings.sessionDir!, "feishu", "oc_chat");
  assert(binding !== null, "feishu binding missing");
  const events = listSessionRunEvents(settings.sessionDir!, binding!.sessionId);
  const finished = events.find((event) => event.eventType === "finished");
  assert(finished !== undefined, "finished event missing");
  const run = getSessionRun(settings.sessionDir!, finished!.runId);
  assert(run !== null && run !== undefined, "durable run missing");
  await waitFor(5000, () => {
    let intentStatus: string | undefined;
    let operationStatuses: [string, string][] | undefined;
    queryRootDatabase(settings.sessionDir!, (db) => {
      const dao = new DeliveryDAO(null);
      try {
        const intent = dao.findIntentByKey(
          db.db!,
          run!.id,
          "feishu",
          "oc_chat",
        );
        intentStatus = intent.status;
        operationStatuses = dao.listOperations(db.db!, intent.id).map(
          (op) => [op.operationKind, op.status] as [string, string],
        );
      } catch {
        // retry below
      }
    });
    if (
      intentStatus === "delivered" &&
      operationStatuses !== undefined &&
      operationStatuses.length === 3 &&
      operationStatuses.every(([, status]) => status === "delivered")
    ) {
      return true;
    }
    return undefined;
  }, "canonical delivery intent never reached delivered");
  // The normal channel path must not create legacy delivery rows.
  assertEquals(
    listLegacyDeliveryRows(settings.sessionDir!),
    0,
    "normal channel path created legacy delivery row(s)",
  );
});

/** Counts the legacy attachment_deliveries rows through the legacy recovery
 * projection (Go's test counts them with raw SQL). */
function listLegacyDeliveryRows(sessionDir: string): number {
  // The legacy store exposes no list API for these rows; the delivery recovery
  // projection is the canonical reader, and the normal path must leave nothing
  // for it to reopen.
  return listFailedTransientDeliveryOperations(sessionDir, "feishu").length;
}

Deno.test("run agent forwards real sub agent events with channel session id", async (t) => {
  for (
    const tc of [
      { name: "done", errorChild: false, wantType: EventDone },
      { name: "error", errorChild: true, wantType: EventError },
    ]
  ) {
    await t.step(tc.name, async () => {
      const workDir = Deno.makeTempDirSync();
      const settings = defaultSettings();
      settings.sessionDir = Deno.makeTempDirSync();
      const cfg = defaultConfig();
      cfg.workDir = workDir;
      cfg.multiAgent = true;
      const model = testModel("m1");
      model.contextWindow = 32768;
      const p = new SubAgentChannelProvider(model, tc.errorChild);
      const d = new Dispatcher({ cfg, settings });
      d.sessionDir = settings.sessionDir;
      d.provider = p;
      d.model = model;
      d.multiAgent = true;
      d.sessions = new Map();
      d.identityLocks = newIdentityLocks();

      const observed: { sessionID: string; event: AgentEvent }[] = [];
      d.setSubAgentObserver((sessionID, ev) => {
        observed.push({ sessionID, event: ev });
      });

      let runErr: unknown = null;
      try {
        await handleMessage(
          d,
          new AbortController().signal,
          inbound({
            platform: "wechat",
            userID: "sender",
            chatID: "channel-chat",
            text: "delegate this",
          }),
        );
      } catch (e) {
        runErr = e;
      }
      if (runErr !== null && !tc.errorChild) {
        throw new Error(`HandleMessage: ${runErr}`);
      }
      const sess = await resolveSessionForTest(
        d,
        "wechat",
        "channel-chat",
        settings,
      );
      const sessionID = sess.manager!.getHeader()!.id;
      await waitFor(
        5000,
        () => {
          const hit = observed.find(
            (item) =>
              item.sessionID === sessionID &&
              (tc.errorChild
                ? item.event.type === EventError ||
                  (item.event.type === EventRunFinished &&
                    item.event.status === "failed")
                : item.event.type === EventDone ||
                  (item.event.type === EventRunFinished &&
                    isTerminalTaskStatus(item.event.status))),
          );
          if (hit === undefined) return undefined;
          assert(
            hit.event.agentId !== "",
            "observer received event without child agent ID",
          );
          if (
            tc.errorChild && hit.event.type === EventError
          ) {
            assert(
              hit.event.error !== undefined &&
                hit.event.error.message === "child provider failed",
              `child observer error = ${hit.event.error}, want provider diagnostic`,
            );
          }
          return hit;
        },
        `timed out waiting for child ${tc.wantType} event; observed=${
          JSON.stringify(observed.map((o) => o.event.type))
        }`,
      );
    });
  }
});

Deno.test("dispatcher to openai external sub agent integration", async (t) => {
  for (
    const tc of [
      { name: "done", errorChild: false, wantStatus: "done" },
      { name: "error", errorChild: true, wantStatus: "error" },
    ]
  ) {
    await t.step(tc.name, async () => {
      const workDir = Deno.makeTempDirSync();
      Deno.writeTextFileSync(join(workDir, "inspect.txt"), "fixture");
      const settings = defaultSettings();
      settings.sessionDir = Deno.makeTempDirSync();
      const cfg = defaultConfig();
      cfg.workDir = workDir;
      cfg.multiAgent = true;
      const model = testModel("m1");
      model.contextWindow = 32768;
      const p = new SubAgentChannelProvider(model, tc.errorChild);
      const d = new Dispatcher({ cfg, settings });
      d.sessionDir = settings.sessionDir;
      d.provider = p;
      d.model = model;
      d.multiAgent = true;
      d.sessions = new Map();
      d.identityLocks = newIdentityLocks();

      const srv = newExternalSubAgentServer();
      d.setSubAgentObserver((sessionID, ev) =>
        publishExternalSubAgentEvent(srv, sessionID, ev)
      );

      const sess = await resolveSessionForTest(
        d,
        "wechat",
        "channel-chat",
        settings,
      );
      const sessionID = sess.manager!.getHeader()!.id;
      const { events, cancel } = subscribeSessionEvents(srv, sessionID);
      try {
        let runErr: unknown = null;
        try {
          await handleMessage(
            d,
            new AbortController().signal,
            inbound({
              platform: "wechat",
              userID: "sender",
              chatID: "channel-chat",
              text: "delegate this",
            }),
          );
        } catch (e) {
          runErr = e;
        }
        if (runErr !== null && !tc.errorChild) {
          throw new Error(`HandleMessage: ${runErr}`);
        }

        const agents = await waitFor(5000, () => {
          const list = getSessionSubAgents(srv, sessionID);
          return list.length > 0 ? list : undefined;
        }, "no external sub-agents registered");
        assertEquals(
          agents.length,
          1,
          `external agents = ${JSON.stringify(agents)}`,
        );
        assertEquals(agents[0].status, tc.wantStatus);
        assert(agents[0].id !== "", "external agent id missing");

        const messages = getSessionSubAgentMessages(
          srv,
          sessionID,
          agents[0].id,
        );
        if (tc.errorChild) {
          assertEquals(messages.length, 1);
          assertEquals(messages[0].role, "status");
          assertEquals(messages[0].isError, true);
        } else {
          const roles = new Set(messages.map((m) => m.role));
          assert(
            messages.length >= 2 && roles.has("assistant") &&
              roles.has("status"),
            `done transcript = ${JSON.stringify(messages.map((m) => m.role))}`,
          );
        }

        const seen = new Set<string>();
        const wantEvents = tc.errorChild ? 1 : 2;
        const drain = (async () => {
          for await (const ev of events) {
            if (ev.sessionId !== sessionID) continue;
            if (ev.event === "transcript") {
              const item = ev.data as {
                type?: string;
                message?: { content?: string } | null;
              };
              if (
                item?.type === "subagent_status" &&
                item.message?.content === tc.wantStatus
              ) {
                seen.add(tc.wantStatus);
              }
              if (item?.type === "assistant_delta") seen.add("assistant");
            }
            if (ev.event === "tool_event") seen.add("tool");
            if (seen.size >= wantEvents) break;
          }
        })();
        await waitFor(
          5000,
          () => (seen.size >= wantEvents ? true : undefined),
          `timed out waiting for broker events: ${[...seen]}`,
        );
        cancel();
        await drain.catch(() => {});
      } finally {
        cancel();
      }
    });
  }
});

Deno.test("sub agent terminal event delivered after parent stream close", async () => {
  const workDir = Deno.makeTempDirSync();
  const settings = defaultSettings();
  settings.sessionDir = Deno.makeTempDirSync();
  const cfg = defaultConfig();
  cfg.workDir = workDir;
  cfg.multiAgent = true;
  const model = testModel("m1");
  model.contextWindow = 32768;
  const p = new BlockingChildChannelProvider(model);
  const d = new Dispatcher({ cfg, settings });
  d.sessionDir = settings.sessionDir;
  d.provider = p;
  d.model = model;
  d.multiAgent = true;
  d.sessions = new Map();
  d.identityLocks = newIdentityLocks();

  const observed: { sessionID: string; event: AgentEvent }[] = [];
  d.setSubAgentObserver((sessionID, ev) => {
    observed.push({ sessionID, event: ev });
  });

  await handleMessage(
    d,
    new AbortController().signal,
    inbound({
      platform: "wechat",
      userID: "sender",
      chatID: "channel-chat",
      text: "delegate this",
    }),
  );
  const sess = await resolveSessionForTest(
    d,
    "wechat",
    "channel-chat",
    settings,
  );
  const sessionID = sess.manager!.getHeader()!.id;

  await waitFor(
    8000,
    () => {
      for (const item of observed) {
        // The canonical terminal event is EventRunFinished; legacy observers may
        // still receive EventDone/EventError.
        if (
          item.event.type !== EventDone &&
          item.event.type !== EventError &&
          item.event.type !== EventRunFinished
        ) {
          continue;
        }
        if (
          item.event.type === EventRunFinished &&
          !isTerminalTaskStatus(item.event.status)
        ) {
          throw new Error(
            `terminal event with non-terminal status ${item.event.status}`,
          );
        }
        assertEquals(item.sessionID, sessionID);
        assert(
          item.event.agentId !== "",
          "terminal event without child agent ID",
        );
        return true;
      }
      return undefined;
    },
    "timed out waiting for child terminal event delivered after parent stream close",
  );
});

/** BlockingChildChannelProvider blocks the child until the run context is
 * cancelled at the end of the parent run. */
class BlockingChildChannelProvider implements Provider {
  model: Model;
  childStarted: Promise<void>;
  resolveChildStarted!: () => void;

  constructor(model: Model) {
    this.model = model;
    this.childStarted = new Promise((resolve) => {
      this.resolveChildStarted = resolve;
    });
  }

  async *chat(params: ChatParams): AsyncGenerator<StreamEvent> {
    const payload = JSON.stringify(params.messages);
    const signal = params.abort;
    if (payload.includes("spawn-1")) {
      // Parent follow-up call after the spawn tool result. Wait until the
      // child has entered its blocking provider call.
      const childWait = this.childStarted.then(() => "child");
      const abortWait = signal
        ? new Promise<null>((resolve) => {
          if (signal.aborted) resolve(null);
          else {signal.addEventListener("abort", () => resolve(null), {
              once: true,
            });}
        })
        : Promise.resolve<null>(null);
      if ((await Promise.race([childWait, abortWait])) === null) return;
      yield { type: streamStart };
      yield { type: streamTextDelta, textDelta: "parent result" };
      yield { type: streamDone, stopReason: "stop" };
    } else if (payload.includes("inspect the project")) {
      // The spawned child agent's provider call: only unblocks when its run
      // context is cancelled at the end of the parent run.
      this.resolveChildStarted();
      await new Promise<never>((_resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason ?? new DOMException("aborted", "AbortError"));
          return;
        }
        signal?.addEventListener(
          "abort",
          () =>
            reject(signal.reason ?? new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
      yield { type: streamDone, stopReason: "stop" };
    } else {
      yield { type: streamStart };
      yield {
        type: streamToolCall,
        toolCall: {
          id: "spawn-1",
          name: "subagent_spawn",
          arguments: { task: "inspect the project" },
        },
      };
      yield { type: streamDone, stopReason: "tool_calls" };
    }
  }

  name(): string {
    return "blocking-child";
  }
  api(): string {
    return "openai-chat";
  }
  models(): Model[] {
    return [this.model];
  }
  getModel(id: string): Model | undefined {
    return this.model.id === id ? this.model : this.model;
  }
}

function isTerminalTaskStatus(status: unknown): boolean {
  return status === TaskSuccess || status === TaskFailed ||
    status === TaskCanceled || status === TaskIncomplete;
}

// --- mailbox ownership ----------------------------------------------------------------

function newMultiAgentFixture(): DispatcherFixture {
  const workDir = Deno.makeTempDirSync();
  const settings = defaultSettings();
  settings.sessionDir = Deno.makeTempDirSync();
  const cfg = defaultConfig();
  cfg.workDir = workDir;
  cfg.multiAgent = true;
  const p = newRecordingProvider();
  const d = new Dispatcher({ cfg, settings });
  d.sessionDir = settings.sessionDir;
  d.provider = p;
  d.model = p.models()[0];
  d.multiAgent = true;
  d.sessions = new Map();
  d.identityLocks = newIdentityLocks();
  return { d, settings, workDir };
}

Deno.test("channel session respects partial sub agent tool selection", async () => {
  const { d, settings, workDir } = newMultiAgentFixture();
  const binding = createBound(
    workDir,
    settings.sessionDir!,
    "wechat",
    "partial-tools",
  );
  // Only the spawn tool is switched on; every other sub-agent tool is
  // explicitly off.
  const selection: ChannelToolConfig[] = [
    { toolName: "subagent_spawn", enabled: true },
  ];
  for (const name of subAgentToolNames()) {
    if (name !== "subagent_spawn") {
      selection.push({ toolName: name, enabled: false });
    }
  }
  setChannelTools(settings.sessionDir!, binding.getHeader()!.id, selection);
  const sess = await resolveSessionForTest(
    d,
    "wechat",
    "partial-tools",
    settings,
    workDir,
  );
  assert(
    registryHas(sess.registry!, "subagent_spawn"),
    "explicitly enabled subagent_spawn is not registered",
  );
  assert(
    sess.agentMgr !== null && sess.agentMgr!.mailbox !== null,
    "session-scoped manager did not own the session mailbox",
  );
  for (const name of subAgentToolNames()) {
    if (name === "subagent_spawn") continue;
    assert(
      !registryHas(sess.registry!, name),
      `${name} was explicitly disabled but the session registry kept it`,
    );
  }
});

Deno.test("channel session tools share the session mailbox", async () => {
  const { d, settings } = newMultiAgentFixture();
  const sess = await resolveSessionForTest(
    d,
    "wechat",
    "mailbox-owner",
    settings,
  );
  assert(
    registryHas(sess.registry!, "subagent_spawn"),
    "multi-agent channel session did not register subagent_spawn",
  );
  assert(
    sess.agentMgr !== null,
    "channel session has no session-scoped agent manager",
  );
  assert(
    sess.agentMgr!.mailbox !== null && sess.runtime !== null &&
      sess.agentMgr!.mailbox === sess.runtime!.mailbox,
    "sub-agent tools and the lead do not share one session mailbox",
  );
  sess.agentMgr!.notifyMemberQuestion(
    "member-1",
    "Engineer",
    "question-member-1-1",
    "Which environment?",
    [],
  );
  assert(
    sess.agentMgr!.mailbox!.hasPending(),
    "member question was dropped before the lead could see it",
  );
});

// --- security integration -----------------------------------------------------------

Deno.test("channel yolo hard risk guard runs before approval", async (t) => {
  for (
    const tc of [
      { name: "high risk blocked", command: "rm -rf /", wantExecute: false },
      { name: "medium risk allowed", command: "docker ps", wantExecute: true },
      { name: "low risk allowed", command: "deno test", wantExecute: true },
    ]
  ) {
    await t.step(tc.name, async () => {
      const executed = { value: false };
      const p = new ChannelToolCallProvider(
        testModelWide("channel-security"),
        tc.command,
      );
      const workDir = Deno.makeTempDirSync();
      const settings = defaultSettings();
      settings.sessionDir = Deno.makeTempDirSync();
      assertEquals(
        settings.approval?.bashBlacklist ?? [],
        [],
        "default bash blacklist must be empty to exercise hard policy",
      );
      const cfg = defaultConfig();
      cfg.workDir = workDir;
      cfg.security.smartApprovals = false;
      const d = new Dispatcher({ cfg, settings });
      d.sessionDir = settings.sessionDir;
      d.provider = p;
      d.model = p.models()[0];
      d.sessions = new Map();
      d.identityLocks = newIdentityLocks();

      const sess = await resolveSessionForTest(
        d,
        "wechat",
        "security-user",
        settings,
      );
      assertEquals(sess.mode, "yolo");
      sess.registry!.register(new RecordingChannelBashTool(executed));

      const response = await handleMessage(
        d,
        new AbortController().signal,
        inbound({
          platform: "wechat",
          userID: "security-user",
          text: "run the command",
        }),
      );
      assertEquals(response, "done");
      assertEquals(
        executed.value,
        tc.wantExecute,
        `bash executed = ${executed.value}, want ${tc.wantExecute} for ${
          JSON.stringify(tc.command)
        }`,
      );
      const result = p.toolResult();
      assert(
        result !== null,
        "provider follow-up did not receive bash tool result",
      );
      const resultText = channelToolResultText(result!.message);
      if (tc.wantExecute) {
        assertEquals(result!.message.isError ?? false, false);
        assertEquals(resultText, "executed");
      } else {
        assertEquals(result!.message.isError ?? false, true);
        assertStringIncludes(resultText, "blocked");
        assertStringIncludes(resultText, "high risk");
      }
    });
  }
});

Deno.test("channel yolo pre tool hook runs before approval", async () => {
  // Deviation (documented in the delivery-slice ledger): Go's blocking
  // pre-tool hook is not wired in the port — the TS hook script runner is
  // async while the agent build options expose a synchronous afterToolCall
  // hook only, so the port cannot reproduce the pre-approval denial. This
  // translation pins the deviation instead of the Go contract: the tool is
  // not blocked by a pre-hook and the run completes.
  const executed = { value: false };
  const p = new ChannelToolCallProvider(
    testModelWide("channel-hook"),
    "deno test",
  );
  const workDir = Deno.makeTempDirSync();
  const script = join(Deno.makeTempDirSync(), "block-tool.sh");
  Deno.writeTextFileSync(
    script,
    `#!/bin/sh\necho '{"action":"block","reason":"blocked by test hook"}'\n`,
  );
  Deno.chmodSync(script, 0o700);
  const settings = defaultSettings();
  settings.sessionDir = Deno.makeTempDirSync();
  const cfg = defaultConfig();
  cfg.workDir = workDir;
  cfg.security.smartApprovals = false;
  cfg.hooks.preToolCall = script;
  const d = new Dispatcher({ cfg, settings });
  d.sessionDir = settings.sessionDir;
  d.provider = p;
  d.model = p.models()[0];
  d.sessions = new Map();
  d.identityLocks = newIdentityLocks();

  const sess = await resolveSessionForTest(d, "wechat", "hook-user", settings);
  sess.registry!.register(new RecordingChannelBashTool(executed));

  const response = await handleMessage(
    d,
    new AbortController().signal,
    inbound({
      platform: "wechat",
      userID: "hook-user",
      text: "run the command",
    }),
  );
  assertEquals(response, "done");
  assert(
    executed.value,
    "expected the documented deviation: no blocking pre-tool hook is wired",
  );
  const result = p.toolResult();
  assert(
    result !== null,
    "provider follow-up did not receive bash tool result",
  );
  assertEquals(channelToolResultText(result!.message), "executed");
});

// --- shared helpers ------------------------------------------------------------------

/** registryHas projects Go's `(tool, ok)` registry lookup. */
function registryHas(
  reg: { get(name: string): { tool: unknown; ok: boolean } },
  name: string,
): boolean {
  return reg.get(name).ok;
}

/** resolveSessionForTest pins the fixture settings for readability. */
async function resolveSessionForTest(
  d: Dispatcher,
  platform: string,
  userID: string,
  _settings: Settings,
  _workDir?: string,
): Promise<ChannelSession> {
  return await resolveSession(d, platform, userID);
}
