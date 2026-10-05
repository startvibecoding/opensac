import { assert, assertEquals, assertRejects } from "@std/assert";
import type { CoreRuntimeEvent } from "../core/runtime.ts";
import {
  coreResult,
  type CoreRpcNotification,
  type CoreRpcRequest,
} from "../core/protocol.ts";
import {
  createCoreClientTUIService,
  type TUICoreClient,
  type TUICoreEventConnection,
} from "./core_service.ts";
import { TUIServiceError } from "./service.ts";

const SESSION_VIEW = {
  sessionId: "session-1",
  workDir: "/workspace/project",
  source: "core",
  providerName: "test-provider",
  modelID: "test-model",
  mode: "yolo",
  thinkingLevel: "",
  capabilities: { multiAgent: true },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

function event(
  sequence: number,
  eventType: string,
  terminal: boolean,
): CoreRuntimeEvent {
  return {
    sessionId: "session-1",
    runId: "run-1",
    sequence,
    eventType,
    payload: { marker: sequence },
    terminal,
  };
}

class FakeEventConnection implements TUICoreEventConnection {
  subscribed: Array<{ sessionId: string; runId: string; cursor: number }> = [];
  replayed: CoreRuntimeEvent[] = [];
  #listeners = new Set<(notification: CoreRpcNotification) => void>();

  subscribe(
    sessionId: string,
    runId: string,
    cursor = 0,
  ): Promise<void> {
    this.subscribed.push({ sessionId, runId, cursor });
    return Promise.resolve();
  }

  replay(
    _sessionId: string,
    _runId: string,
    cursor = 0,
  ): Promise<unknown> {
    return Promise.resolve(
      this.replayed.filter((entry) => entry.sequence > cursor),
    );
  }

  onNotification(
    listener: (notification: CoreRpcNotification) => void,
  ): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onRequest(
    _listener: (request: CoreRpcRequest) => void,
  ): () => void {
    return () => {};
  }

  #closeListeners = new Set<() => void>();

  onClose(listener: () => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  respond(_response: ReturnType<typeof coreResult>): void {}

  /** Stands in for a Core that dropped this socket on its own. */
  drop(): void {
    for (const listener of [...this.#closeListeners]) listener();
  }

  emit(event: CoreRuntimeEvent): void {
    const notification: CoreRpcNotification = {
      jsonrpc: "2.0",
      method: "run.event",
      params: event as unknown as Record<string, unknown>,
    };
    for (const listener of [...this.#listeners]) listener(notification);
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }
}

interface FakeClient extends TUICoreClient {
  calls: Array<{ method: string; params: unknown }>;
  events: FakeEventConnection;
  /** Every event connection handed out, in dial order. */
  eventConnections: FakeEventConnection[];
}

function fakeClient(
  results: Record<string, unknown | (() => unknown)> = {},
  options: {
    failWith?: (method: string) => Error | undefined;
    /** Hand out a new event connection per dial, as a real client would. */
    freshEvents?: boolean;
  } = {},
): FakeClient {
  const events = new FakeEventConnection();
  const eventConnections: FakeEventConnection[] = [];
  return {
    calls: [],
    events,
    eventConnections,
    call<T>(method: string, params?: unknown): Promise<T> {
      this.calls.push({ method, params });
      const failure = options.failWith?.(method);
      if (failure !== undefined) return Promise.reject(failure);
      const result = results[method];
      if (result === undefined) {
        return Promise.reject(new Error(`unexpected call: ${method}`));
      }
      return Promise.resolve(
        (typeof result === "function" ? result() : result) as T,
      );
    },
    connectEvents(): Promise<TUICoreEventConnection> {
      const connection = options.freshEvents === true
        ? new FakeEventConnection()
        : events;
      eventConnections.push(connection);
      const failure = options.failWith?.("connectEvents");
      if (failure !== undefined) return Promise.reject(failure);
      return Promise.resolve(connection);
    },
  };
}

Deno.test("core TUIService forwards session creation without adapter defaults", async () => {
  const client = fakeClient({ "session.create": SESSION_VIEW });
  const service = createCoreClientTUIService(client, {
    now: () => new Date("2026-01-03T00:00:00.000Z"),
  });

  const view = await service.createSession({
    workDir: "/workspace/project",
    providerName: "test-provider",
    modelID: "test-model",
  });
  assertEquals(client.calls, [{
    method: "session.create",
    params: {
      workDir: "/workspace/project",
      providerName: "test-provider",
      modelID: "test-model",
    },
  }]);
  assertEquals(view.sessionId, "session-1");
  assertEquals(view.capabilities, { multiAgent: true });
  // Wire timestamps revive into Date values.
  assertEquals(
    view.createdAt.toISOString(),
    "2026-01-01T00:00:00.000Z",
  );

  // Optional policy fields travel only when the caller set them; effective
  // defaults stay Core-owned.
  client.calls.length = 0;
  await service.createSession({
    workDir: "/w",
    mode: "agent",
    thinkingLevel: "",
    capabilities: {},
  });
  assertEquals(client.calls[0].params, {
    workDir: "/w",
    mode: "agent",
    thinkingLevel: "",
    capabilities: {},
  });
});

Deno.test("core TUIService maps prompt, cancel, and config calls to Core methods", async () => {
  const client = fakeClient({
    "session.prompt": {
      sessionId: "session-1",
      runId: "run-1",
      status: "running",
    },
    "run.cancel": {
      sessionId: "session-1",
      runId: "run-1",
      status: "cancelled",
      sequence: 2,
      startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
    },
    "session.config.set": SESSION_VIEW,
  });
  const service = createCoreClientTUIService(client);

  const accepted = await service.prompt({
    sessionId: "session-1",
    text: "hello",
    attachments: ["image-1"],
  });
  assertEquals(accepted, {
    sessionId: "session-1",
    runId: "run-1",
    status: "running",
  });
  assertEquals(client.calls[0], {
    method: "session.prompt",
    params: {
      sessionId: "session-1",
      text: "hello",
      attachments: ["image-1"],
    },
  });

  const run = await service.cancelRun({
    sessionId: "session-1",
    runId: "run-1",
  });
  assertEquals(run.status, "cancelled");
  assertEquals(client.calls[1].method, "run.cancel");

  const updated = await service.setSessionConfig({
    sessionId: "session-1",
    mode: "agent",
  });
  assertEquals(updated.sessionId, "session-1");
  assertEquals(client.calls[2], {
    method: "session.config.set",
    params: { sessionId: "session-1", mode: "agent" },
  });
});

Deno.test("core TUIService rethrows prompt errors unchanged", async () => {
  const marker = new Error("provider exploded");
  const client = fakeClient({}, {
    failWith: (method) => method === "session.prompt" ? marker : undefined,
  });
  const service = createCoreClientTUIService(client);

  let caught: unknown;
  try {
    await service.prompt({ sessionId: "session-1", text: "hello" });
  } catch (error) {
    caught = error;
  }
  assertEquals(caught, marker);
});

Deno.test("core TUIService streams replayed events then live events until terminal", async () => {
  const client = fakeClient();
  client.events.replayed = [event(1, "run_started", false)];
  const service = createCoreClientTUIService(client);

  const iterator = service.subscribeRunEvents("session-1", "run-1", 0);
  assertEquals((await iterator.next()).value?.sequence, 1);

  // A live copy of an already replayed sequence must not be duplicated.
  client.events.emit(event(1, "run_started", false));
  const pending = iterator.next();
  client.events.emit(event(2, "run_finished", true));
  assertEquals((await pending).value, event(2, "run_finished", true));
  assertEquals(await iterator.next(), { done: true, value: undefined });

  assertEquals(client.events.subscribed, [
    { sessionId: "session-1", runId: "run-1", cursor: 0 },
  ]);
  // The stream released its notification listener after the terminal event.
  assertEquals(client.events.listenerCount, 0);
});

Deno.test("core TUIService starts event streams from the requested cursor", async () => {
  const client = fakeClient();
  client.events.replayed = [
    event(1, "run_started", false),
    event(2, "run_finished", true),
  ];
  const service = createCoreClientTUIService(client);

  const events: CoreRuntimeEvent[] = [];
  for await (
    const event of service.subscribeRunEvents("session-1", "run-1", 1)
  ) {
    events.push(event);
  }
  assertEquals(events.map((entry) => entry.sequence), [2]);
  assertEquals(client.events.subscribed, [
    { sessionId: "session-1", runId: "run-1", cursor: 1 },
  ]);
});

Deno.test("core TUIService ends a run stream the Core drops instead of hanging", async () => {
  const client = fakeClient();
  client.events.replayed = [event(1, "run_started", false)];
  const service = createCoreClientTUIService(client);

  const iterator = service.subscribeRunEvents("session-1", "run-1", 0);
  assertEquals((await iterator.next()).value?.sequence, 1);

  // The Core restarted: the socket is gone and the run died with it. Waiting
  // for a notification that can never arrive would leave the TUI spinning
  // forever, so the stream has to end with an error instead.
  const pending = iterator.next();
  client.events.drop();
  const error = await assertRejects(() => pending, TUIServiceError);
  assert(
    error.message.includes("run-1"),
    `the error must name the lost run, got ${error.message}`,
  );
  assertEquals(client.events.listenerCount, 0);
});

Deno.test("core TUIService reports missing capabilities explicitly", async () => {
  const client = fakeClient();
  const service = createCoreClientTUIService(client);

  // Attachment intake without a run has no Core-owned path yet; staged inputs
  // use `prepareInput`, so this stays the explicit missing capability.
  const error = await assertRejects(
    () =>
      service.addAttachment({
        sessionId: "session-1",
        name: "a.png",
        mediaType: "image/png",
        contentBase64: "aGk=",
      }),
    TUIServiceError,
  );
  assertEquals(
    error.message,
    "TUI capability is not available in the Core Runtime",
  );
  assertEquals(client.calls, []);
});

Deno.test("core TUIService projects the secret-safe settings view", async () => {
  const client = fakeClient({
    "manage.settings.get": {
      defaultProvider: "test-provider",
      defaultModel: "test-model",
      defaultMode: "yolo",
      thinkingLevel: "",
      sandboxEnabled: true,
      sandboxLevel: "strict",
      webSearchEnabled: false,
      skillsDisabled: [],
      providers: [{
        name: "test-provider",
        maskedKey: "sk-***redacted",
        apiKeyConfigured: true,
        modelCount: 1,
        models: [{ id: "test-model", name: "Test Model" }],
      }],
    },
  });
  const service = createCoreClientTUIService(client);

  const view = await service.settings();
  assertEquals(view.defaultProvider, "test-provider");
  assertEquals(view.providers, [{
    name: "test-provider",
    apiKeyConfigured: true,
    modelCount: 1,
    models: [{ id: "test-model", name: "Test Model" }],
  }]);
  // The projection only carries masked credential state, never raw secrets.
  assertEquals(
    JSON.stringify(view).includes("sk-***redacted"),
    false,
  );
  assertEquals(client.calls.map((call) => call.method), [
    "manage.settings.get",
  ]);
});

Deno.test("core TUIService maps skill activation onto the Core skill method", async () => {
  const client = fakeClient({
    "session.skill.set": { sessionId: "session-1", activeSkills: ["review"] },
    "session.config.get": { ...SESSION_VIEW, capabilities: {} },
    "session.skills.list": [
      {
        name: "review",
        source: "project",
        description: "Review skill",
        active: true,
      },
    ],
  });
  const service = createCoreClientTUIService(client);

  const view = await service.setSkillActive({
    sessionId: "session-1",
    name: "review",
    active: true,
  });
  assertEquals(view.sessionId, "session-1");
  assertEquals(client.calls.map((call) => call.method), [
    "session.skill.set",
    "session.config.get",
  ]);
  assertEquals(client.calls[0].params, {
    sessionId: "session-1",
    name: "review",
    active: true,
  });

  const skills = await service.listSkills({ sessionId: "session-1" });
  assertEquals(skills, [{
    name: "review",
    source: "project",
    description: "Review skill",
    active: true,
  }]);
});

Deno.test("core TUIService lists attachments for the session", async () => {
  const client = fakeClient({
    "attachment.list": {
      attachments: [{
        attachmentId: "att-1",
        filename: "notes.txt",
        kind: "file",
        mediaType: "text/plain",
        size: 12,
        status: "ready",
        runId: "run-1",
        createdAt: "2026-01-01T00:00:00.000Z",
      }],
    },
  });
  const service = createCoreClientTUIService(client);

  const attachments = await service.listAttachments({
    sessionId: "session-1",
  });
  assertEquals(attachments, [{
    attachmentId: "att-1",
    name: "notes.txt",
    mediaType: "text/plain",
    size: 12,
  }]);
  // The Core scopes attachment reads by session (work directory stays Core-side).
  assertEquals(client.calls[0], {
    method: "attachment.list",
    params: { sessionId: "session-1" },
  });
});

Deno.test("core TUIService materializes prepared inputs through the Core", async () => {
  const client = fakeClient({
    "input.prepare": {
      resourceId: "resource-1",
      kind: "image",
      relativePath: ".opensac/inputs/resource-1",
      filename: "clipboard.png",
      mediaType: "image/png",
      bytes: 2,
    },
  });
  const service = createCoreClientTUIService(client);

  const prepared = await service.prepareInput({
    sessionId: "session-1",
    name: "clipboard.png",
    mediaType: "image/png",
    contentBase64: "aGk=",
    kind: "image",
  });
  assertEquals(prepared, {
    resourceId: "resource-1",
    kind: "image",
    relativePath: ".opensac/inputs/resource-1",
    filename: "clipboard.png",
    mediaType: "image/png",
    bytes: 2,
  });
  assertEquals(client.calls[0].method, "input.prepare");
});

Deno.test("core TUIService projects capability discovery metadata", async () => {
  const client = fakeClient({
    "session.capabilities": {
      sandbox: { enabled: true, available: true },
      browser: { enabled: false, available: true },
    },
  });
  const service = createCoreClientTUIService(client);

  const view = await service.capabilities({ sessionId: "session-1" });
  assertEquals(view, {
    sandbox: { enabled: true, available: true },
    browser: { enabled: false, available: true },
  });
  assertEquals(client.calls[0], {
    method: "session.capabilities",
    params: { sessionId: "session-1" },
  });
});

Deno.test("core TUIService rejects malformed Core views", async () => {
  const client = fakeClient({
    "session.create": { sessionId: "session-1" },
    "session.open": null,
  });
  const service = createCoreClientTUIService(client);

  await assertRejects(
    () => service.createSession({ workDir: "/w" }),
    TUIServiceError,
    "invalid session view",
  );
  await assertRejects(
    () => service.openSession({ sessionId: "session-1" }),
    TUIServiceError,
    "invalid session view",
  );
});

Deno.test("core TUIService maps missing timestamps to the provided clock", async () => {
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...withoutDates } =
    SESSION_VIEW;
  const client = fakeClient({ "session.create": withoutDates });
  const service = createCoreClientTUIService(client, {
    now: () => new Date("2026-02-01T00:00:00.000Z"),
  });
  const view = await service.createSession({
    workDir: "/w",
    providerName: "p",
    modelID: "m",
  });
  assert(view.createdAt instanceof Date);
  assertEquals(view.createdAt.toISOString(), "2026-02-01T00:00:00.000Z");
  assertEquals(view.updatedAt.toISOString(), "2026-02-01T00:00:00.000Z");
});

Deno.test("core TUIService reads and updates settings documents through the Core", async () => {
  const client = fakeClient({
    "settings.get": { defaultProvider: "p", defaultModel: "m", providers: {} },
    "settings.update": {
      defaultProvider: "p2",
      defaultModel: "m",
      providers: {},
    },
  });
  const service = createCoreClientTUIService(client, {
    workDir: "/workspace/project",
  });

  const doc = await service.getSettings();
  assertEquals(client.calls[0], {
    method: "settings.get",
    params: { scope: "effective", workDir: "/workspace/project" },
  });
  assertEquals(doc.defaultProvider, "p");

  client.calls.length = 0;
  const scoped = await service.getSettings({ scope: "global" });
  assertEquals(client.calls[0], {
    method: "settings.get",
    params: { scope: "global", workDir: "/workspace/project" },
  });
  assertEquals(scoped.defaultProvider, "p");

  client.calls.length = 0;
  const updated = await service.updateSettings({
    scope: "project",
    updates: { defaultModel: "m" },
  });
  assertEquals(client.calls[0], {
    method: "settings.update",
    params: {
      scope: "project",
      updates: { defaultModel: "m" },
      workDir: "/workspace/project",
    },
  });
  // The update returns the fresh effective document.
  assertEquals(updated.defaultProvider, "p2");
});

Deno.test("core TUIService projects the provider catalog and validates pairs", async () => {
  const client = fakeClient({
    "model.catalog": [{
      id: "test-provider",
      configured: true,
      isDefault: true,
      api: "openai-chat",
      baseUrl: "https://example.invalid",
      modelCount: 1,
      models: [{ id: "test-model", name: "Test Model" }],
    }],
    "model.validate": null,
  });
  const service = createCoreClientTUIService(client, { workDir: "/w" });

  const catalog = await service.listProviders();
  assertEquals(client.calls[0], {
    method: "model.catalog",
    params: { workDir: "/w" },
  });
  assertEquals(catalog[0].models, [{ id: "test-model", name: "Test Model" }]);
  assertEquals(catalog[0].configured, true);

  client.calls.length = 0;
  await service.validateProviderModel({
    providerID: "test-provider",
    modelID: "test-model",
  });
  assertEquals(client.calls[0], {
    method: "model.validate",
    params: {
      providerID: "test-provider",
      modelID: "test-model",
      workDir: "/w",
    },
  });
});

Deno.test("core TUIService rethrows provider validation errors with the raw cause", async () => {
  const client = fakeClient({}, {
    failWith: (method) =>
      method === "model.validate"
        ? new Error(
          "unknown provider: nope (add it to settings.json providers section)",
        )
        : undefined,
  });
  const service = createCoreClientTUIService(client);
  await assertRejects(
    () =>
      service.validateProviderModel({ providerID: "nope", modelID: "nope" }),
    Error,
    "unknown provider: nope (add it to settings.json providers section)",
  );
});

Deno.test("core TUIService round-trips env and session context documents", async () => {
  const client = fakeClient({
    "env.list": { A: "1" },
    "env.update": { A: "2" },
    "session.context.get": { ruleContent: "r", extraContext: "e" },
    "session.context.set": { ruleContent: "r2", extraContext: "e" },
  });
  const service = createCoreClientTUIService(client);

  assertEquals(await service.listEnv(), { A: "1" });
  assertEquals(await service.updateEnv({ vars: { A: "2" } }), { A: "2" });
  assertEquals(client.calls[0], { method: "env.list", params: undefined });
  assertEquals(client.calls[1], {
    method: "env.update",
    params: { vars: { A: "2" } },
  });

  const context = await service.getSessionContext({ sessionId: "session-1" });
  assertEquals(context, { ruleContent: "r", extraContext: "e" });
  const updated = await service.setSessionContext({
    sessionId: "session-1",
    ruleContent: "r2",
  });
  assertEquals(updated.ruleContent, "r2");
  assertEquals(client.calls[2], {
    method: "session.context.get",
    params: { sessionId: "session-1" },
  });
  assertEquals(client.calls[3], {
    method: "session.context.set",
    params: { sessionId: "session-1", ruleContent: "r2" },
  });
});

Deno.test("core TUIService maps expert commands and forks onto Core methods", async () => {
  const client = fakeClient({
    "expert.list": [{
      name: "demo-expert",
      displayName: { zh: "演示专家", en: "Demo Expert" },
      expertType: "team",
      source: "builtin",
      invalid: false,
      invalidReason: "",
    }],
    "expert.show": {
      name: "demo-expert",
      displayName: { zh: "演示专家", en: "Demo Expert" },
      expertType: "team",
      invalid: false,
      invalidReason: "",
      members: [{
        id: "lead",
        name: { zh: "领队", en: "Lead" },
        profession: { zh: "工程", en: "Engineering" },
        role: "lead",
      }],
    },
    "expert.state": { expertId: "demo-expert" },
    "expert.set": { expertId: "" },
    "session.fork": { ...SESSION_VIEW, sessionId: "session-2" },
  });
  const service = createCoreClientTUIService(client);

  const experts = await service.listExperts({ sessionId: "session-1" });
  assertEquals(client.calls[0], {
    method: "expert.list",
    params: { sessionId: "session-1" },
  });
  assertEquals(experts[0].displayName.en, "Demo Expert");
  assertEquals(experts[0].expertType, "team");

  const bundle = await service.showExpert({
    sessionId: "session-1",
    expertId: "demo-expert",
  });
  assertEquals(client.calls[1], {
    method: "expert.show",
    params: { sessionId: "session-1", expertId: "demo-expert" },
  });
  assertEquals(bundle.members[0].role, "lead");

  assertEquals(
    await service.expertState({ sessionId: "session-1" }),
    { expertId: "demo-expert" },
  );
  assertEquals(
    await service.setExpert({ sessionId: "session-1", expertId: "" }),
    { expertId: "" },
  );
  const child = await service.forkSession({
    sessionId: "session-1",
    expertId: "demo-expert",
    titleMode: "",
  });
  assertEquals(client.calls[4], {
    method: "session.fork",
    params: {
      sessionId: "session-1",
      expertId: "demo-expert",
      titleMode: "",
    },
  });
  assertEquals(child.sessionId, "session-2");
});

Deno.test("core TUIService maps agent, delegate, ESM, transient, and compact calls to Core methods", async () => {
  const objective = {
    sessionId: "session-1",
    esmId: "esm-1",
    objective: "ship",
    status: "active",
    tokensUsed: 0,
    timeUsedMs: 0,
    blockedCount: 0,
    blockedReason: "",
    blockedRunId: "",
    completionReason: "",
    completionRunId: "",
    completionReview: "",
    phase: "worker",
    progressSummary: "",
    remainingWork: ["test"],
    rejectionCount: 0,
    rejectionRunId: "",
    recoveryCount: 0,
    recoveryReason: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const client = fakeClient({
    "agent.list": [
      { id: "a1", parent: "", children: ["a2"], state: "running" },
    ],
    "agent.destroy": null,
    "delegate.set": { enabled: true },
    "delegate.get": { enabled: true },
    "session.capability.set": {
      sandbox: { enabled: true, available: true },
    },
    "esm.state": {
      objective,
      workerRunning: true,
      activeAgentId: "a2",
    },
    "esm.update": {
      objective: null,
      workerRunning: false,
      activeAgentId: "",
    },
    "esm.continue": { runId: "esm-run", started: true },
    "esm.stop": null,
    "transient.prompt": { answer: "side" },
    "session.compact": {
      sessionId: "session-1",
      runId: "compact-1",
      status: "running",
    },
  });
  const service = createCoreClientTUIService(client, {
    now: () => new Date("2026-01-03T00:00:00.000Z"),
  });

  assertEquals(await service.listAgents({ sessionId: "session-1" }), [{
    id: "a1",
    parent: "",
    children: ["a2"],
    state: "running",
  }]);
  await service.destroyAgent({ sessionId: "session-1", agentId: "a1" });
  assertEquals(
    await service.setDelegate({ sessionId: "session-1", enabled: true }),
    { enabled: true },
  );
  assertEquals(await service.delegateState({ sessionId: "session-1" }), {
    enabled: true,
  });
  assertEquals(
    await service.setCapability({
      sessionId: "session-1",
      id: "browser",
      enabled: true,
    }),
    { sandbox: { enabled: true, available: true } },
  );
  const state = await service.esmState({ sessionId: "session-1" });
  assertEquals(state.activeAgentId, "a2");
  assertEquals(state.workerRunning, true);
  assertEquals(state.objective?.remainingWork, ["test"]);
  assertEquals(state.objective?.esmId, "esm-1");
  const updated = await service.esmCommand({
    sessionId: "session-1",
    action: "clear",
  });
  assertEquals(updated.objective, null);
  assertEquals(await service.esmContinue({ sessionId: "session-1" }), {
    runId: "esm-run",
    started: true,
  });
  await service.esmStop({ sessionId: "session-1" });
  assertEquals(
    await service.askTransient({
      sessionId: "session-1",
      question: "what?",
    }),
    { answer: "side" },
  );
  assertEquals(await service.compact({ sessionId: "session-1" }), {
    sessionId: "session-1",
    runId: "compact-1",
    status: "running",
  });

  // Every capability maps to exactly one neutral Core method.
  assertEquals(client.calls.map((entry) => entry.method), [
    "agent.list",
    "agent.destroy",
    "delegate.set",
    "delegate.get",
    "session.capability.set",
    "esm.state",
    "esm.update",
    "esm.continue",
    "esm.stop",
    "transient.prompt",
    "session.compact",
  ]);
  assertEquals(client.calls[5].params, { sessionId: "session-1" });
  assertEquals(client.calls[6].params, {
    sessionId: "session-1",
    action: "clear",
  });
  assertEquals(client.calls[9].params, {
    sessionId: "session-1",
    question: "what?",
  });
});

Deno.test("core TUIService re-establishes the decision bridge after the Core drops it", async () => {
  const client = fakeClient(
    {
      "session.prompt": {
        sessionId: "session-1",
        runId: "run-1",
        status: "running",
      },
    },
    { freshEvents: true },
  );
  const service = createCoreClientTUIService(client);

  // The bridge is established once and reused, not re-dialed per prompt.
  await service.prompt({ sessionId: "session-1", text: "one" });
  await service.prompt({ sessionId: "session-1", text: "two" });
  assertEquals(client.eventConnections.length, 1);

  // A Core restart drops the socket. The next prompt must re-dial, otherwise
  // no approval could ever be requested again.
  client.eventConnections[0].drop();
  await service.prompt({ sessionId: "session-1", text: "three" });
  assertEquals(client.eventConnections.length, 2);
  // The replacement connection is the one now carrying decisions.
  assertEquals(client.eventConnections[0].listenerCount, 0);
});

Deno.test("core TUIService retries the decision bridge after a failed dial", async () => {
  let failNext = true;
  const client = fakeClient(
    {
      "session.prompt": {
        sessionId: "session-1",
        runId: "run-1",
        status: "running",
      },
    },
    {
      freshEvents: true,
      failWith: (method) =>
        method === "connectEvents" && failNext
          ? new TUIServiceError("Core event WebSocket failed")
          : undefined,
    },
  );
  const service = createCoreClientTUIService(client);

  // A bridge that could not be dialed must not be cached, or every later
  // prompt would reuse the rejection and no decision could ever arrive again.
  await service.prompt({ sessionId: "session-1", text: "one" });
  failNext = false;
  await service.prompt({ sessionId: "session-1", text: "two" });
  assertEquals(client.eventConnections.length, 2);
});

Deno.test("core TUIService reports a Core restart and the reconnect that follows", async () => {
  const client = fakeClient(
    {
      "session.prompt": {
        sessionId: "session-1",
        runId: "run-1",
        status: "running",
      },
    },
    { freshEvents: true },
  );
  const service = createCoreClientTUIService(client);
  const states: string[] = [];
  const stop = service.onConnectionState((state) => states.push(state));

  // A subscriber sees the current state, not an assumed one.
  assertEquals(states, ["connected"]);

  await service.prompt({ sessionId: "session-1", text: "one" });
  client.eventConnections[0].drop();
  await service.prompt({ sessionId: "session-1", text: "two" });

  assertEquals(states, ["connected", "reconnecting", "connected"]);
  // The first delivery is the subscribe-time replay, not a transition.
  assertEquals(states.length, 3);
  stop();
  client.eventConnections[1].drop();
  assertEquals(states.length, 3, "an unsubscribed listener hears nothing");
});

Deno.test("core TUIService projects session.transcript and rejects a broken role", async () => {
  const service = createCoreClientTUIService(
    fakeClient({
      "session.transcript": [
        { role: "user", text: "earlier turn" },
        { role: "assistant", text: "earlier reply" },
      ],
    }),
    { workDir: "/workspace/project" },
  );
  assertEquals(await service.getTranscript({ sessionId: "session-1" }), [
    { role: "user", text: "earlier turn" },
    { role: "assistant", text: "earlier reply" },
  ]);

  // The transport is untrusted: an unknown role is a broken projection, so it
  // must fail loudly rather than render arbitrary text as a conversation turn.
  const broken = createCoreClientTUIService(
    fakeClient({ "session.transcript": [{ role: "toolResult", text: "x" }] }),
    { workDir: "/workspace/project" },
  );
  await assertRejects(
    () => broken.getTranscript({ sessionId: "session-1" }),
    Error,
    "invalid transcript message role",
  );
});
