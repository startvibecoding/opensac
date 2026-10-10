// deno-lint-ignore-file require-await -- async fake host models the Promise-based Runtime seam
import { assert, assertEquals } from "../compat/assert.ts";
import { CoreRuntimeDispatcher } from "./dispatcher.ts";
import { CoreEventStream } from "./event_stream.ts";
import { type CoreRpcParams } from "./protocol.ts";
import { type CoreRuntimeHost } from "./runtime.ts";
import { test } from "#testing";

function testHost(
  extension?: CoreRuntimeHost["extension"],
): CoreRuntimeHost {
  return {
    async createSession(input) {
      return {
        sessionId: "session-1",
        workDir: input.workDir,
        source: "acp",
        providerName: input.providerName ?? "test-provider",
        modelID: input.modelID ?? "test-model",
        mode: input.mode ?? "yolo",
        thinkingLevel: input.thinkingLevel ?? "",
        capabilities: input.capabilities ?? {},
        approvalPolicy: "runtime",
        questionPolicy: "runtime",
        createdAt: new Date(0),
        updatedAt: new Date(0),
      };
    },
    async openSession() {
      throw new Error("not used");
    },
    async closeSession() {},
    async deleteSession() {},
    async listSessionSkills() {
      return [];
    },
    async prepareInput(input) {
      return {
        resourceId: "resource-1",
        kind: "file",
        relativePath: "",
        filename: input.name,
        mediaType: input.mediaType,
        bytes: 0,
      };
    },
    async sessionCapabilities() {
      return {};
    },
    async sessionContext() {
      return { ruleContent: "", extraContext: "" };
    },
    async setSessionContext() {
      return { ruleContent: "", extraContext: "" };
    },
    async settingsDocument() {
      return {};
    },
    async updateSettingsDocument() {
      return {};
    },
    async providerCatalog() {
      return [];
    },
    async validateProviderModel() {},
    async envDocument() {
      return {};
    },
    async updateEnvDocument(input) {
      return input.vars;
    },
    async listExperts() {
      return [];
    },
    async inspectExpert() {
      return {
        name: "",
        displayName: { zh: "", en: "" },
        expertType: "",
        invalid: false,
        invalidReason: "",
        members: [],
      };
    },
    async expertState() {
      return { expertId: "" };
    },
    async setExpert() {
      return { expertId: "" };
    },
    async forkSession() {
      return {
        sessionId: "session-2",
        workDir: "/tmp",
        source: "acp",
        providerName: "test-provider",
        modelID: "test-model",
        mode: "yolo",
        thinkingLevel: "",
        capabilities: {},
        approvalPolicy: "runtime",
        questionPolicy: "runtime",
        createdAt: new Date(0),
        updatedAt: new Date(0),
      };
    },
    async listAgents() {
      return [];
    },
    async destroyAgent() {},
    async setDelegate(input) {
      return { enabled: input.enabled };
    },
    async delegateState() {
      return { enabled: false };
    },
    async setSessionCapability() {
      return {};
    },
    async esmState() {
      return { objective: null, workerRunning: false, activeAgentId: "" };
    },
    async esmUpdate() {
      return { objective: null, workerRunning: false, activeAgentId: "" };
    },
    async esmContinue() {
      return { runId: "", started: false };
    },
    async esmStop() {},
    async transientPrompt() {
      return { answer: "" };
    },
    async compact(input) {
      return {
        sessionId: input.sessionId,
        runId: "compact-1",
        status: "running",
      };
    },
    async history() {
      return [];
    },
    async transcript() {
      return [];
    },
    async prompt(input) {
      return { sessionId: input.sessionId, runId: "run-1", status: "running" };
    },
    async cancelRun(input) {
      return {
        sessionId: input.sessionId,
        runId: input.runId,
        status: "cancelled",
        sequence: 2,
        startedAt: new Date(0),
        updatedAt: new Date(1),
      };
    },
    async getRun() {
      return undefined;
    },
    async listSessions() {
      return [];
    },
    async listPersistedSessions() {
      return [];
    },
    async setSessionConfig(input) {
      return {
        sessionId: input.sessionId,
        workDir: "/tmp",
        source: "acp",
        providerName: input.providerName ?? "test-provider",
        modelID: input.modelID ?? "test-model",
        mode: input.mode ?? "yolo",
        thinkingLevel: input.thinkingLevel ?? "",
        capabilities: input.capabilities ?? {},
        approvalPolicy: "runtime",
        questionPolicy: "runtime",
        createdAt: new Date(0),
        updatedAt: new Date(0),
      };
    },
    subscribeRunEvents() {
      return (async function* () {})();
    },
    async close() {},
    extension,
  };
}

test("CoreRuntimeDispatcher dispatches session.create and preserves request id", async () => {
  const dispatcher = new CoreRuntimeDispatcher({
    host: testHost(),
    events: new CoreEventStream(),
  });
  const response = await dispatcher.dispatch({
    jsonrpc: "2.0",
    id: 1,
    method: "session.create",
    params: { workDir: "/tmp/project" },
  }, new AbortController().signal);

  assertEquals(response?.id, 1);
  assertEquals(
    response?.result && (response.result as { sessionId: string }).sessionId,
    "session-1",
  );
});

test("CoreRuntimeDispatcher dispatches session.listPersisted listings", async () => {
  const seen: Array<{ workDir?: string }> = [];
  const host = {
    ...testHost(),
    async listPersistedSessions(input: { workDir?: string }) {
      seen.push({ ...input });
      return [{
        sessionId: "session-9",
        workDir: input.workDir ?? "",
        modTime: new Date(0),
        messageCount: 2,
        preview: "hello",
      }];
    },
  };
  const dispatcher = new CoreRuntimeDispatcher({
    host,
    events: new CoreEventStream(),
  });
  const response = await dispatcher.dispatch({
    jsonrpc: "2.0",
    id: 1,
    method: "session.listPersisted",
    params: { workDir: "/tmp/project" },
  }, new AbortController().signal);
  assertEquals(seen, [{ workDir: "/tmp/project" }]);
  assertEquals(
    (response?.result as Array<{ sessionId: string }>)[0].sessionId,
    "session-9",
  );
  // Missing params mean "the Core host's own work directory".
  await dispatcher.dispatch({
    jsonrpc: "2.0",
    id: 2,
    method: "session.listPersisted",
  }, new AbortController().signal);
  assertEquals(seen[1], {});
});

test("CoreRuntimeDispatcher routes session.transcript to the durable projection", async () => {
  const seen: Array<{ sessionId: string }> = [];
  const host = {
    ...testHost(),
    async transcript(input: { sessionId: string }) {
      seen.push({ ...input });
      return [{ role: "user", text: "earlier turn" } as const];
    },
  };
  const dispatcher = new CoreRuntimeDispatcher({
    host,
    events: new CoreEventStream(),
  });
  const response = await dispatcher.dispatch({
    jsonrpc: "2.0",
    id: 1,
    method: "session.transcript",
    params: { sessionId: "session-9" },
  }, new AbortController().signal);
  assertEquals(seen, [{ sessionId: "session-9" }]);
  assertEquals(response?.result, [{ role: "user", text: "earlier turn" }]);
});
test("run.events.subscribe attributes the subscription to the calling client", async () => {
  // The `/events` upgrade registers the client identity, but the subscribe itself
  // arrives as an RPC message. Without the caller's identity threaded through,
  // `core.clients.list` reported every RPC-channel subscription as ownerless, so
  // an operator could not tell which connection was watching which run.
  const events = new CoreEventStream();
  const dispatcher = new CoreRuntimeDispatcher({ host: testHost(), events });
  events.registerClient("client-7");
  await dispatcher.dispatch(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "run.events.subscribe",
      params: { sessionId: "session-1", runId: "run-1", cursor: 0 },
    },
    new AbortController().signal,
    { clientId: "client-7" },
  );
  const listed = events.listClients();
  assertEquals(listed.length, 1);
  assertEquals(listed[0]?.clientId, "client-7");
  assertEquals(listed[0]?.subscriptions, [{
    sessionId: "session-1",
    runId: "run-1",
  }]);

  // A caller that sends no identity still subscribes; it just cannot be
  // attributed, which must not silently steal another client's subscription.
  await dispatcher.dispatch(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "run.events.subscribe",
      params: { sessionId: "session-2", runId: "run-2", cursor: 0 },
    },
    new AbortController().signal,
  );
  assertEquals(
    events.listClients().find((c) => c.clientId === "client-7")?.subscriptions,
    [{ sessionId: "session-1", runId: "run-1" }],
  );
  await events.close();
});

test("run.events.subscribe releases its attribution row when the client unsubscribes", async () => {
  // The attribution marks the conditional rpc-only row. Releasing it (the
  // socket's matching subscription ended, or the client explicitly went away)
  // must drop the row again: a stateless HTTP caller must never linger in
  // `core.clients.list` after it stopped watching.
  const events = new CoreEventStream();
  const dispatcher = new CoreRuntimeDispatcher({ host: testHost(), events });
  await dispatcher.dispatch(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "run.events.subscribe",
      params: { sessionId: "session-1", runId: "run-1", cursor: 0 },
    },
    new AbortController().signal,
    { clientId: "rpc-9" },
  );
  assertEquals(
    events.listClients().find((c) => c.clientId === "rpc-9")?.subscriptions,
    [{ sessionId: "session-1", runId: "run-1" }],
  );
  assertEquals(events.releaseAttribution("rpc-9"), true);
  assertEquals(
    events.listClients().find((c) => c.clientId === "rpc-9"),
    undefined,
    "the released attribution must not leave a ghost row",
  );
  await events.close();
});

test("CoreRuntimeDispatcher sends extension methods to the Core extension handler", async () => {
  const calls: string[] = [];
  const dispatcher = new CoreRuntimeDispatcher({
    host: testHost(async (method) => {
      calls.push(method);
      return { ok: true };
    }),
    events: new CoreEventStream(),
  });
  const response = await dispatcher.dispatch({
    jsonrpc: "2.0",
    id: "extension",
    method: "project.list",
    params: {},
  }, new AbortController().signal);
  assertEquals(response?.id, "extension");
  assertEquals(response?.result, { ok: true });
  assertEquals(calls, ["project.list"]);
});
test("CoreRuntimeDispatcher returns stable errors and no response for notifications", async () => {
  const dispatcher = new CoreRuntimeDispatcher({
    host: testHost(),
    events: new CoreEventStream(),
  });
  const unknown = await dispatcher.dispatch({
    jsonrpc: "2.0",
    id: "unknown",
    method: "does.not.exist",
  }, new AbortController().signal);
  assertEquals(unknown?.error?.code, -32601);

  const invalid = await dispatcher.dispatch({
    jsonrpc: "2.0",
    id: "invalid",
    method: "session.create",
    params: { workDir: 42 },
  }, new AbortController().signal);
  assertEquals(invalid?.error?.code, -32602);

  const notification = await dispatcher.dispatch({
    jsonrpc: "2.0",
    method: "session.close",
    params: { sessionId: "session-1" },
  }, new AbortController().signal);
  assertEquals(notification, undefined);
});

test("CoreRuntimeDispatcher forwards neutral policy and content fields to the host", async () => {
  const captured: Array<{ method: string; input: unknown }> = [];
  const base = testHost();
  const host: CoreRuntimeHost = {
    ...base,
    async createSession(input) {
      captured.push({ method: "createSession", input });
      return await base.createSession(input);
    },
    async prompt(input) {
      captured.push({ method: "prompt", input });
      return await base.prompt(input);
    },
  };
  const dispatcher = new CoreRuntimeDispatcher({
    host,
    events: new CoreEventStream(),
  });

  await dispatcher.dispatch({
    jsonrpc: "2.0",
    id: 1,
    method: "session.create",
    params: {
      workDir: "/tmp/project",
      providerName: "test-provider",
      modelID: "test-model",
      mode: "agent",
      thinkingLevel: "",
      capabilities: { multiAgent: true },
      source: "cli",
      approvalPolicy: "print",
      questionPolicy: "unattended",
    },
  }, new AbortController().signal);
  await dispatcher.dispatch({
    jsonrpc: "2.0",
    id: 2,
    method: "session.prompt",
    params: {
      sessionId: "session-1",
      text: "hello",
      attachments: ["image-1"],
      metadata: { source: "cli" },
    },
  }, new AbortController().signal);

  // These fields were previously dropped by the param parsers, silently
  // ignoring ACP --mode/--thinking and prompt attachments on the Core RPC.
  assertEquals(captured, [
    {
      method: "createSession",
      input: {
        workDir: "/tmp/project",
        providerName: "test-provider",
        modelID: "test-model",
        mode: "agent",
        thinkingLevel: "",
        capabilities: { multiAgent: true },
        source: "cli",
        approvalPolicy: "print",
        questionPolicy: "unattended",
      },
    },
    {
      method: "prompt",
      input: {
        sessionId: "session-1",
        text: "hello",
        attachments: ["image-1"],
        metadata: { source: "cli" },
      },
    },
  ]);
});

test("CoreRuntimeDispatcher rejects malformed neutral fields instead of dropping them", async () => {
  const dispatcher = new CoreRuntimeDispatcher({
    host: testHost(),
    events: new CoreEventStream(),
  });

  for (
    const params of [
      {
        workDir: "/tmp",
        mode: 5,
      },
      {
        workDir: "/tmp",
        capabilities: { multiAgent: "yes" },
      },
      {
        sessionId: "session-1",
        text: "hello",
        attachments: ["ok", 3],
      },
      {
        sessionId: "session-1",
        text: "hello",
        metadata: [1, 2],
      },
    ]
  ) {
    const response = await dispatcher.dispatch({
      jsonrpc: "2.0",
      id: 9,
      method: "workDir" in params ? "session.create" : "session.prompt",
      params: params as Record<string, unknown>,
    }, new AbortController().signal);
    assertEquals(response?.error?.code, -32602);
  }
});

test("CoreRuntimeDispatcher routes the settings, catalog, env, and context surfaces", async () => {
  const seen: Array<[string, unknown]> = [];
  const host = {
    ...testHost(),
    async settingsDocument(input: {
      scope?: "effective" | "global";
      workDir?: string;
    }) {
      seen.push(["settingsDocument", input]);
      return { defaultProvider: "p" };
    },
    async updateSettingsDocument(input: {
      scope: "global" | "project";
      updates: Record<string, unknown>;
      workDir?: string;
    }) {
      seen.push(["updateSettingsDocument", input]);
      return {};
    },
    async providerCatalog(input: { workDir?: string }) {
      seen.push(["providerCatalog", input]);
      return [];
    },
    async validateProviderModel(input: {
      providerID: string;
      modelID: string;
      workDir?: string;
    }) {
      seen.push(["validateProviderModel", input]);
      if (input.providerID === "nope") {
        throw new Error("unknown provider: nope");
      }
    },
    async envDocument() {
      seen.push(["envDocument", {}]);
      return { A: "1" };
    },
    async updateEnvDocument(input: { vars: Record<string, string> }) {
      seen.push(["updateEnvDocument", input]);
      return input.vars;
    },
    async sessionContext(input: { sessionId: string }) {
      seen.push(["sessionContext", input]);
      return { ruleContent: "r", extraContext: "e" };
    },
    async setSessionContext(input: {
      sessionId: string;
      ruleContent?: string;
      extraContext?: string;
    }) {
      seen.push(["setSessionContext", input]);
      return {
        ruleContent: input.ruleContent ?? "",
        extraContext: input.extraContext ?? "",
      };
    },
  };
  const dispatcher = new CoreRuntimeDispatcher({
    host,
    events: new CoreEventStream(),
  });
  const call = (
    id: number,
    method: string,
    params?: Record<string, unknown>,
  ) =>
    dispatcher.dispatch(
      {
        jsonrpc: "2.0",
        id,
        method,
        ...(params === undefined ? {} : { params }),
      },
      new AbortController().signal,
    );

  const settings = await call(1, "settings.get", {
    scope: "global",
    workDir: "/w",
  });
  assertEquals(
    (settings?.result as { defaultProvider: string }).defaultProvider,
    "p",
  );
  await call(2, "settings.update", {
    scope: "project",
    updates: { a: 1 },
    workDir: "/w",
  });
  await call(3, "model.catalog", { workDir: "/w" });
  await call(4, "model.validate", {
    providerID: "p",
    modelID: "m",
    workDir: "/w",
  });
  const failure = await call(5, "model.validate", {
    providerID: "nope",
    modelID: "m",
  });
  // Validation failures carry the raw cause.
  assertEquals(failure?.error?.message, "unknown provider: nope");
  await call(6, "env.list");
  await call(7, "env.update", { vars: { A: "1" } });
  await call(8, "session.context.get", { sessionId: "s1" });
  await call(9, "session.context.set", {
    sessionId: "s1",
    ruleContent: "r",
  });
  const invalid = await call(10, "settings.update", {
    scope: "nope",
    updates: {},
  });
  assertEquals(invalid?.error?.code, -32602);

  assertEquals(seen, [
    ["settingsDocument", { scope: "global", workDir: "/w" }],
    [
      "updateSettingsDocument",
      { scope: "project", updates: { a: 1 }, workDir: "/w" },
    ],
    ["providerCatalog", { workDir: "/w" }],
    ["validateProviderModel", { providerID: "p", modelID: "m", workDir: "/w" }],
    ["validateProviderModel", {
      providerID: "nope",
      modelID: "m",
      workDir: "",
    }],
    ["envDocument", {}],
    ["updateEnvDocument", { vars: { A: "1" } }],
    ["sessionContext", { sessionId: "s1" }],
    ["setSessionContext", { sessionId: "s1", ruleContent: "r" }],
  ]);
});

test("CoreRuntimeDispatcher routes expert and fork requests", async () => {
  const seen: Array<[string, unknown]> = [];
  const host = {
    ...testHost(),
    async listExperts(input: { sessionId: string }) {
      seen.push(["listExperts", input]);
      return [];
    },
    async inspectExpert(input: { sessionId: string; expertId: string }) {
      seen.push(["inspectExpert", input]);
      return {
        name: input.expertId,
        displayName: { zh: "", en: "" },
        expertType: "agent",
        invalid: false,
        invalidReason: "",
        members: [],
      };
    },
    async expertState(input: { sessionId: string }) {
      seen.push(["expertState", input]);
      return { expertId: "" };
    },
    async setExpert(input: { sessionId: string; expertId: string }) {
      seen.push(["setExpert", input]);
      return { expertId: input.expertId };
    },
    async forkSession(input: {
      sessionId: string;
      expertId?: string;
      titleMode?: string;
    }) {
      seen.push(["forkSession", input]);
      return {
        sessionId: "session-2",
        workDir: "/tmp",
        source: "acp",
        providerName: "",
        modelID: "",
        mode: "yolo",
        thinkingLevel: "",
        capabilities: {},
        approvalPolicy: "runtime",
        questionPolicy: "runtime",
        createdAt: new Date(0),
        updatedAt: new Date(0),
      };
    },
  };
  const dispatcher = new CoreRuntimeDispatcher({
    host,
    events: new CoreEventStream(),
  });
  const call = (
    id: number,
    method: string,
    params?: Record<string, unknown>,
  ) =>
    dispatcher.dispatch(
      {
        jsonrpc: "2.0",
        id,
        method,
        ...(params === undefined ? {} : { params }),
      },
      new AbortController().signal,
    );

  await call(1, "expert.list", { sessionId: "s1" });
  await call(2, "expert.show", { sessionId: "s1", expertId: "e1" });
  // expert.show requires an explicit expert identity.
  const invalidShow = await call(3, "expert.show", { sessionId: "s1" });
  assertEquals(invalidShow?.error?.code, -32602);
  await call(4, "expert.state", { sessionId: "s1" });
  await call(5, "expert.set", { sessionId: "s1", expertId: "e1" });
  await call(6, "session.fork", {
    sessionId: "s1",
    expertId: "e1",
    titleMode: "",
  });

  assertEquals(seen, [
    ["listExperts", { sessionId: "s1" }],
    ["inspectExpert", { sessionId: "s1", expertId: "e1" }],
    ["expertState", { sessionId: "s1" }],
    ["setExpert", { sessionId: "s1", expertId: "e1" }],
    ["forkSession", { sessionId: "s1", expertId: "e1", titleMode: "" }],
  ]);
});

test("CoreRuntimeDispatcher forwards the advanced agent, delegate, ESM, and transient surface", async () => {
  const captured: Array<{ method: string; input: unknown }> = [];
  const base = testHost();
  const host: CoreRuntimeHost = {
    ...base,
    async listAgents(input) {
      captured.push({ method: "listAgents", input });
      return await base.listAgents(input);
    },
    async destroyAgent(input) {
      captured.push({ method: "destroyAgent", input });
    },
    async setDelegate(input) {
      captured.push({ method: "setDelegate", input });
      return await base.setDelegate(input);
    },
    async setSessionCapability(input) {
      captured.push({ method: "setSessionCapability", input });
      return await base.setSessionCapability(input);
    },
    async esmUpdate(input) {
      captured.push({ method: "esmUpdate", input });
      return await base.esmUpdate(input);
    },
    async esmContinue(input) {
      captured.push({ method: "esmContinue", input });
      return { runId: "esm-1", started: true };
    },
    async esmStop(input) {
      captured.push({ method: "esmStop", input });
    },
    async transientPrompt(input) {
      captured.push({ method: "transientPrompt", input });
      return { answer: "side" };
    },
    async compact(input) {
      captured.push({ method: "compact", input });
      return await base.compact(input);
    },
  };
  const dispatcher = new CoreRuntimeDispatcher({
    host,
    events: new CoreEventStream(),
  });
  const signal = new AbortController().signal;
  const call = (id: number | string, method: string, params?: CoreRpcParams) =>
    dispatcher.dispatch(
      { jsonrpc: "2.0", id, method, params },
      signal,
    );

  assertEquals(
    (await call(1, "agent.list", { sessionId: "session-1" }))?.result,
    [],
  );
  assertEquals(
    (await call(2, "agent.destroy", {
      sessionId: "session-1",
      agentId: "a1",
    }))?.result,
    null,
  );
  assertEquals(
    (await call(3, "delegate.set", {
      sessionId: "session-1",
      enabled: true,
    }))?.result,
    { enabled: true },
  );
  assertEquals(
    (await call(4, "session.capability.set", {
      sessionId: "session-1",
      id: "browser",
      enabled: true,
    }))?.result,
    {},
  );
  assertEquals(
    (await call(5, "esm.update", {
      sessionId: "session-1",
      action: "create",
      objective: "ship",
    }))?.result,
    { objective: null, workerRunning: false, activeAgentId: "" },
  );
  assertEquals(
    (await call(6, "esm.continue", { sessionId: "session-1" }))?.result,
    { runId: "esm-1", started: true },
  );
  assertEquals(
    (await call(7, "esm.stop", { sessionId: "session-1" }))?.result,
    null,
  );
  assertEquals(
    (await call(8, "transient.prompt", {
      sessionId: "session-1",
      question: "what?",
    }))?.result,
    { answer: "side" },
  );
  assertEquals(
    (await call(9, "session.compact", { sessionId: "session-1" }))?.result,
    {
      sessionId: "session-1",
      runId: "compact-1",
      status: "running",
    },
  );

  // Invalid parameter shapes are rejected before reaching the host.
  const badAgent = await call(10, "agent.destroy", { sessionId: "session-1" });
  assertEquals(badAgent?.error?.code, -32602);
  const badEsm = await call(11, "esm.update", {
    sessionId: "session-1",
    action: "bogus",
  });
  assertEquals(badEsm?.error?.code, -32602);

  assertEquals(captured, [
    { method: "listAgents", input: { sessionId: "session-1" } },
    {
      method: "destroyAgent",
      input: { sessionId: "session-1", agentId: "a1" },
    },
    {
      method: "setDelegate",
      input: { sessionId: "session-1", enabled: true },
    },
    {
      method: "setSessionCapability",
      input: { sessionId: "session-1", id: "browser", enabled: true },
    },
    {
      method: "esmUpdate",
      input: {
        sessionId: "session-1",
        action: "create",
        objective: "ship",
      },
    },
    { method: "esmContinue", input: { sessionId: "session-1" } },
    { method: "esmStop", input: { sessionId: "session-1" } },
    {
      method: "transientPrompt",
      input: { sessionId: "session-1", question: "what?" },
    },
    { method: "compact", input: { sessionId: "session-1" } },
  ]);
});

test("session.open tolerates a blank workDir and keeps a real one", async () => {
  const seen: Array<{ sessionId: string; workDir?: string }> = [];
  const dispatcher = new CoreRuntimeDispatcher({
    host: {
      ...testHost(),
      async openSession(input: { sessionId: string; workDir?: string }) {
        seen.push({ ...input });
        return { sessionId: input.sessionId } as never;
      },
    },
    events: new CoreEventStream(),
  });
  const call = (params: Record<string, unknown>) =>
    dispatcher.dispatch({
      jsonrpc: "2.0",
      id: 1,
      method: "session.open",
      params,
    }, new AbortController().signal);

  // A front end that serializes an unset directory must not silently scope the
  // open to a path that cannot match any session's cwd.
  await call({ sessionId: "s-1", workDir: "" });
  await call({ sessionId: "s-1", workDir: "   " });
  assertEquals(seen, [{ sessionId: "s-1" }, { sessionId: "s-1" }]);

  // A real directory is passed through, trimmed.
  await call({ sessionId: "s-1", workDir: " /workspace/app " });
  assertEquals(seen[2], { sessionId: "s-1", workDir: "/workspace/app" });

  // A present non-string is still a malformed request, not an absent one.
  const before = seen.length;
  const response = await call({ sessionId: "s-1", workDir: 42 });
  assertEquals(
    seen.length,
    before,
    "an invalid workDir must not reach the host",
  );
  assert(response?.error !== undefined, "a non-string workDir is rejected");
});
