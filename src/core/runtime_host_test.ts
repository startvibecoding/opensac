// deno-lint-ignore-file require-await -- async fake runtime models the Promise-based Runtime seam
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@opensac/assert";
import { encodeBase64 } from "@opensac/encoding/base64";
import { join } from "@opensac/path";
import {
  defaultSettings,
  getSessionDir,
  type Settings,
} from "../config/settings.ts";
import { CoreSessionNotResidentError } from "./runtime_protocol.ts";
import { openOrCreateSession } from "../agentruntime/session_lifecycle.ts";
import { SessionRecoveryRequiredError } from "../session/mod.ts";
import { createSQLiteCronStore } from "../cron/sqlite_store.ts";
import { knowledgeBaseCronJobID } from "../agentruntime/knowledge_cron.ts";
import {
  createKnowledgeBaseService,
  defaultKnowledgeBaseIndexPolicy,
} from "../agentruntime/knowledgebase.ts";
import {
  claimDeliveryOperation,
  closeDatabases,
  createDeliveryPlan,
  currentRuntimeLeaseBinding,
  type DeliveryOperation,
  type DeliveryPlan,
  getDeliveryOperation,
  getExecutionIntent,
  openByIDExact,
  updateDeliveryOperation,
  validateRuntimeLease,
} from "../session/mod.ts";
import {
  type DurableRun,
  RunStore,
  SessionRunEventSink,
} from "../agentruntime/mod.ts";
import { getDurableRun } from "../agentruntime/run_queries.ts";
import { create as createFactoryProvider } from "../provider/factory/factory.ts";
import { MockProvider } from "../provider/mock.ts";
import {
  type ChatParams,
  type Model,
  streamDone,
  streamError,
  type StreamEvent,
  streamTextDelta,
} from "../provider/types.ts";
import { SOURCE_ACP, SOURCE_TUI } from "../agentruntime/source.ts";
import type { Service as SkillHubService } from "../skillhub/mod.ts";
import { AttachmentService } from "../agentruntime/input.ts";
import { defaultAttachmentPolicy } from "../agentruntime/attachment.ts";
import {
  createCoreRuntimeHost,
  createProductionCoreExtensionHandler,
  createProductionCoreRuntimeDependencies,
} from "./runtime_host.ts";
import type {
  CoreExtensionHandler,
  CoreRuntimeEvent,
  CoreRuntimeHostOptions,
  CoreSessionRuntime,
} from "./runtime.ts";
import {
  testWithIsolatedConfig as test,
  withIsolatedConfig,
} from "../test_helpers.ts";

class FakeSessionRuntime implements CoreSessionRuntime {
  readonly sessionId: string;
  readonly events: string[] = [];
  cancelled: string[] = [];
  closed = false;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  async prompt(input: { text: string }): Promise<{ runId: string }> {
    this.events.push(`prompt:${input.text}`);
    return { runId: `${this.sessionId}-run` };
  }

  async cancelRun(runId: string): Promise<void> {
    this.cancelled.push(runId);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class StreamingSessionRuntime implements CoreSessionRuntime {
  readonly sessionId: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  async prompt(input: { text: string }): Promise<{
    runId: string;
    events: AsyncIterable<CoreRuntimeEvent>;
  }> {
    const runId = `${this.sessionId}-stream`;
    const sessionId = this.sessionId;
    return {
      runId,
      events: (async function* () {
        yield {
          sessionId,
          runId,
          sequence: 99,
          eventType: "text_delta",
          payload: { text: input.text },
          terminal: false,
        };
        yield {
          sessionId,
          runId,
          sequence: 100,
          eventType: "run_finished",
          payload: { status: "completed" },
          terminal: true,
        };
      })(),
    };
  }

  async cancelRun(_runId: string): Promise<void> {}

  async close(): Promise<void> {}
}

function seedFailedDelivery(sessionDir: string, failureCode: string): {
  sessionId: string;
  operationId: string;
} {
  const sessionId = "core-delivery-session";
  const operationId = "core-delivery-op";
  const started = new Date();
  const run: DurableRun = {
    id: "core-delivery-run",
    sessionId,
    intentId: "core-delivery-intent",
    retryOf: "",
    attempt: 1,
    workDir: "",
    source: "test",
    model: "test",
    mode: "yolo",
    status: "completed",
    startedAt: started,
    finishedAt: started,
    error: "",
    errorInfo: {},
    progress: {},
    usage: null,
    contextUsage: null,
    inputResourceIds: [],
    submissionKeyHash: "",
    submissionScope: "",
    submissionFingerprint: "",
    userEntryId: "",
    assistantEntryId: "",
    conversationTurnId: "core-delivery-turn",
    conversationTurn: true,
  };
  new RunStore(sessionDir).create(run);
  new SessionRunEventSink(sessionDir).recordJSON(
    sessionId,
    run.id,
    "started",
    run.source,
    run.status,
    run.model,
    run.mode,
    { intentId: run.intentId, attempt: run.attempt },
  );
  const operation: DeliveryOperation = {
    id: operationId,
    intentId: "core-delivery-intent",
    operationKey: "caption",
    artifactId: "",
    operationKind: "send_text",
    sequence: 1,
    dependsOn: "",
    idempotencyKey: operationId,
    payloadDigest: "sha256:core",
    status: "pending",
    providerAssetId: "",
    providerMessageId: "",
    providerState: undefined,
    attemptCount: 0,
    nextAttemptAt: null,
    failureCode: "",
    retryWindowStartedAt: null,
    leaseOwner: "",
    leaseEpoch: 0,
    createdAt: started,
    updatedAt: started,
  };
  const plan: DeliveryPlan = {
    intent: {
      id: operation.intentId,
      sessionId,
      runId: run.id,
      platform: "wechat",
      targetId: "chat",
      replyMessageId: "",
      transportContext: { caption: "hello" },
      status: "pending",
      createdAt: started,
      updatedAt: started,
    },
    operations: [operation],
  };
  createDeliveryPlan(sessionDir, plan);
  const claimed = claimDeliveryOperation(
    sessionDir,
    operationId,
    "core-test-worker",
    new Date(),
    60_000,
  );
  updateDeliveryOperation(
    sessionDir,
    operationId,
    "core-test-worker",
    claimed.leaseEpoch,
    "failed",
    "",
    "",
    undefined,
    failureCode,
    null,
  );
  return { sessionId, operationId };
}

test("production Core dependencies create and close a persisted session", async () => {
  const workDir = await Deno.makeTempDir({
    prefix: "opensac-core-production-",
  });
  try {
    const host = await createCoreRuntimeHost({
      source: SOURCE_ACP,
      workDir,
      settings: defaultSettings(),
      providerName: "",
      modelID: "",
      dependencies: createProductionCoreRuntimeDependencies(defaultSettings()),
    });
    const session = await host.createSession({ workDir });
    assertEquals(session.workDir, workDir);
    await host.closeSession({ sessionId: session.sessionId });
    await host.close();
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

test("a restarted Core reports a persisted session as not resident and re-opens it", async () => {
  const workDir = await Deno.makeTempDir({
    prefix: "opensac-core-restart-",
  });
  try {
    const settings = defaultSettings();
    const options = {
      source: SOURCE_ACP,
      workDir,
      settings,
      providerName: "",
      modelID: "",
      dependencies: createProductionCoreRuntimeDependencies(settings),
    };
    const before = await createCoreRuntimeHost(options);
    const session = await before.createSession({ workDir });
    await before.close();

    // A new Core process shares the session database but not the previous
    // process's in-memory session map.
    const after = await createCoreRuntimeHost(options);
    try {
      assertEquals(
        (await after.listSessions()).length,
        0,
        "a restarted Core has no resident session",
      );
      await assertRejects(
        () => after.history({ sessionId: session.sessionId }),
        CoreSessionNotResidentError,
      );
      // The persisted identity is intact and re-opening restores it.
      assert(
        (await after.listPersistedSessions({ workDir })).some((entry) =>
          entry.sessionId === session.sessionId
        ),
        "the persisted session survives the restart",
      );
      const reopened = await after.openSession({
        sessionId: session.sessionId,
      });
      assertEquals(reopened.sessionId, session.sessionId);
      assertEquals(
        (await after.history({ sessionId: session.sessionId })).length,
        0,
      );
    } finally {
      await after.close();
    }
  } finally {
    await Deno.remove(workDir, { recursive: true });
    closeDatabases();
  }
});

test("a restarted Core converges a Run left running by the previous process", async () => {
  const workDir = await Deno.makeTempDir({
    prefix: "opensac-core-orphan-",
  });
  try {
    const settings = defaultSettings();
    const sessionDir = getSessionDir(settings);
    const options = {
      source: SOURCE_ACP,
      workDir,
      settings,
      providerName: "",
      modelID: "",
      dependencies: createProductionCoreRuntimeDependencies(settings),
    };
    const before = await createCoreRuntimeHost(options);
    const session = await before.createSession({ workDir });
    const started = new Date();
    // A durable Run whose owning process is gone: the Core died mid-run.
    new RunStore(sessionDir).create(
      {
        id: "orphan-run",
        sessionId: session.sessionId,
        intentId: "orphan-intent",
        retryOf: "",
        attempt: 1,
        workDir,
        source: "acp",
        model: "",
        mode: "yolo",
        status: "running",
        startedAt: started,
        finishedAt: new Date(0),
        error: "",
        errorInfo: {},
        progress: {},
        usage: null,
        contextUsage: null,
        inputResourceIds: [],
        submissionKeyHash: "",
        submissionScope: "",
        submissionFingerprint: "",
        userEntryId: "",
        assistantEntryId: "",
        conversationTurnId: "",
        conversationTurn: false,
      } satisfies DurableRun,
    );
    await before.close();

    const after = await createCoreRuntimeHost(options);
    try {
      await after.openSession({ sessionId: session.sessionId });
      // Admission reconciles the orphan through the shared recovery path
      // rather than surfacing a bare recovery-required error. A prompt that
      // never reaches its provider is enough: the point is that admission no
      // longer rejects the session.
      let failure: unknown;
      try {
        await after.prompt({ sessionId: session.sessionId, text: "hi" });
      } catch (error) {
        failure = error;
      }
      assert(
        !(failure instanceof SessionRecoveryRequiredError),
        `admission must recover the orphan, got ${
          failure instanceof Error ? failure.name : String(failure)
        }`,
      );
    } finally {
      await after.close();
    }
  } finally {
    await Deno.remove(workDir, { recursive: true });
    closeDatabases();
  }
});

test("Core-owned session identity is minted, listed, and reopens with its persisted mode", async () => {
  const workDir = await Deno.makeTempDir({
    prefix: "opensac-core-identity-",
  });
  try {
    const settings = defaultSettings();
    const host = await createCoreRuntimeHost({
      source: SOURCE_ACP,
      workDir,
      settings,
      providerName: "",
      modelID: "",
      dependencies: createProductionCoreRuntimeDependencies(settings),
    });
    const session = await host.createSession({ workDir });
    assert(session.sessionId !== "", "the Core mints the persisted identity");
    // The identity is persisted eagerly: it appears in the persisted listing
    // before any prompt ran and survives close/reopen (TUI session switching).
    const listed = await host.listPersistedSessions({ workDir });
    assert(
      listed.some((entry) => entry.sessionId === session.sessionId),
      `expected ${session.sessionId} in ${JSON.stringify(listed)}`,
    );
    // Persisted session facts (work directory and mode) reach the view on
    // open instead of being resolved by a front-end.
    const manager = openByIDExact(getSessionDir(settings), session.sessionId);
    manager.appendModeChange("plan");
    await host.closeSession({ sessionId: session.sessionId });
    const reopened = await host.openSession({ sessionId: session.sessionId });
    assertEquals(reopened.sessionId, session.sessionId);
    assertEquals(reopened.workDir, workDir);
    assertEquals(reopened.mode, "plan");
    await host.close();
  } finally {
    await Deno.remove(workDir, { recursive: true });
    closeDatabases();
  }
});

test("production Core dependencies execute a prompt with a provider", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "opensac-core-prompt-" });
  const model: Model = {
    id: "mock-model",
    name: "Mock Model",
    provider: "mock",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 1024,
  };
  const provider = new MockProvider("mock", [model], [
    { type: streamTextDelta, textDelta: "hello" },
    { type: streamDone, stopReason: "end_turn" },
  ]);
  try {
    const settings = defaultSettings();
    const host = await createCoreRuntimeHost({
      source: SOURCE_ACP,
      workDir,
      settings,
      providerName: "mock",
      modelID: model.id,
      dependencies: createProductionCoreRuntimeDependencies(
        settings,
        () => ({ provider, model }),
      ),
    });
    const session = await host.createSession({ workDir });
    const accepted = await host.prompt({
      sessionId: session.sessionId,
      text: "hi",
    });
    const events = host.subscribeRunEvents(session.sessionId, accepted.runId);
    const collected: CoreRuntimeEvent[] = [];
    for await (const event of events) collected.push(event);
    assertEquals(collected[0].eventType, "run_started");
    assertEquals(
      collected.some((event) => event.eventType === "text_delta"),
      true,
    );
    assertEquals(collected.at(-1)?.eventType, "run_finished");
    assertEquals(
      collected.find((event) => event.eventType === "text_delta")?.payload.text,
      "hello",
    );
    // The terminal assistant message is durable: the Runtime-owned turn end
    // stages it through the shared execution observation, so a resumed front
    // end reprints the reply instead of only the user turns.
    assertEquals(await host.transcript({ sessionId: session.sessionId }), [
      { role: "user", text: "hi" },
      { role: "assistant", text: "hello" },
    ]);
    await host.close();
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

test("Core Runtime Host consumes SessionRuntime event streams", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "opensac-core-stream-" });
  try {
    const observed: CoreRuntimeEvent[] = [];
    const host = await createCoreRuntimeHost({
      source: SOURCE_ACP,
      workDir,
      settings: defaultSettings(),
      providerName: "test-provider",
      modelID: "test-model",
      eventSink: (event) => observed.push(event),
      dependencies: {
        createSessionRuntime: (input) =>
          new StreamingSessionRuntime(input.sessionId),
      },
    });
    const session = await host.createSession({ workDir });
    const accepted = await host.prompt({
      sessionId: session.sessionId,
      text: "hi",
    });
    const events = host.subscribeRunEvents(session.sessionId, accepted.runId);
    const collected: CoreRuntimeEvent[] = [];
    for await (const event of events) collected.push(event);
    assertEquals(collected.map((event) => [event.eventType, event.sequence]), [
      ["run_started", 1],
      ["text_delta", 2],
      ["run_finished", 3],
    ]);
    assertEquals(observed.map((event) => event.eventType), [
      "run_started",
      "text_delta",
      "run_finished",
    ]);
    await host.close();
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

test("production Core extension handler owns project, attachment, doctor, and env surfaces", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "opensac-core-extension-" });
  try {
    const settings = defaultSettings();
    settings.sessionDir = join(workDir, "sessions");
    settings.defaultProvider = "alpha";
    settings.defaultModel = "alpha-model";
    settings.providers = {
      alpha: {
        api: "openai-chat",
        baseUrl: "https://alpha.example/v1",
        apiKey: "secret-alpha-key",
        models: [{ id: "alpha-model", name: "Alpha" }],
      },
    };
    const handler = createProductionCoreExtensionHandler(settings);
    const project = await handler(
      "project.create",
      { name: "Alpha" },
      new AbortController().signal,
    );
    const projects = await handler(
      "project.list",
      {},
      new AbortController().signal,
    );
    const attachments = await handler(
      "attachment.list",
      { sessionId: "missing-session" },
      new AbortController().signal,
    );
    const env = await handler(
      "manage.env.get",
      {},
      new AbortController().signal,
    );
    const settingsView = await handler(
      "manage.settings.get",
      {},
      new AbortController().signal,
    );
    assertEquals(
      (settingsView as { defaultProvider: string }).defaultProvider,
      "alpha",
    );
    assertEquals(
      JSON.stringify(settingsView).includes("secret-alpha-key"),
      false,
    );
    const providers = await handler(
      "manage.providers.list",
      {},
      new AbortController().signal,
    );
    assertEquals(
      (providers as { providers: { name: string; maskedKey: string }[] })
        .providers[0].name,
      "alpha",
    );
    assertEquals(
      JSON.stringify(providers).includes("secret-alpha-key"),
      false,
    );
    const doctor = await handler(
      "doctor",
      { cwd: workDir },
      new AbortController().signal,
    );
    const attachmentService = new AttachmentService(
      settings.sessionDir,
      defaultAttachmentPolicy(),
    );
    const attachment = await attachmentService.acceptArtifact(
      "session-1",
      "run-1",
      {
        origin: "test",
        reference: "test://note.txt",
        kind: "file",
        filename: "note.txt",
        mediaType: "text/plain",
        sizeHint: 5,
        open: () => ({ bytes: new TextEncoder().encode("hello") }),
      },
    );
    const fetched = await handler(
      "attachment.fetch",
      { sessionId: "session-1", attachmentId: attachment.id },
      new AbortController().signal,
    );
    const stored = await handler(
      "attachment.store",
      {
        sessionId: "session-2",
        runId: "run-2",
        filename: "stored.txt",
        mediaType: "text/plain",
        contentBase64: encodeBase64(new TextEncoder().encode("stored")),
      },
      new AbortController().signal,
    );
    const storedId = (stored as { attachmentId: string }).attachmentId;

    assertEquals((project as { name: string }).name, "Alpha");
    const listed = (projects as {
      projects: { id: string; name: string; sessionCount: number }[];
    }).projects;
    assertEquals(listed[0].id, (project as { id: string }).id);
    assertEquals(listed[0].name, "Alpha");
    assertEquals(listed[0].sessionCount, 0);
    assertEquals(attachments, { attachments: [] });
    assertEquals(
      Array.isArray((env as { variables: unknown[] }).variables),
      true,
    );
    assertEquals((doctor as { checks: unknown[] }).checks.length > 0, true);
    assertEquals(fetched, {
      filename: "note.txt",
      mediaType: "text/plain",
      size: 5,
      contentBase64: encodeBase64(new TextEncoder().encode("hello")),
    });
    assertEquals((stored as { filename: string }).filename, "stored.txt");
    const storedFetched = await handler(
      "attachment.fetch",
      { sessionId: "session-2", attachmentId: storedId },
      new AbortController().signal,
    );
    assertEquals(
      (storedFetched as { contentBase64: string }).contentBase64,
      encodeBase64(new TextEncoder().encode("stored")),
    );

    const expert = await handler(
      "manage.experts.create",
      {
        scope: "project",
        cwd: workDir,
        bundle: {
          manifest: {
            schemaVersion: 1,
            name: "core-expert",
            expertType: "agent",
            agentName: "lead",
            displayName: { zh: "核心专家", en: "Core Expert" },
          },
          agents: { lead: "---\nname: lead\n---\nCore expert.\n" },
        },
      },
      new AbortController().signal,
    );
    assertEquals((expert as { scope: string }).scope, "project");
    const expertList = await handler(
      "manage.experts.list",
      { scope: "project", cwd: workDir },
      new AbortController().signal,
    );
    assertEquals(
      (expertList as { experts: { name: string }[] }).experts.some((item) =>
        item.name === "core-expert"
      ),
      true,
    );
    const expertBundle = (expert as { bundle: { manifest: { name: string } } })
      .bundle;
    const fetchedExpert = await handler(
      "manage.experts.get",
      { scope: "project", cwd: workDir, name: "core-expert" },
      new AbortController().signal,
    );
    assertEquals(
      (fetchedExpert as { bundle: { manifest: { name: string } } }).bundle
        .manifest
        .name,
      expertBundle.manifest.name,
    );
    await handler(
      "manage.experts.delete",
      { scope: "project", cwd: workDir, name: "core-expert" },
      new AbortController().signal,
    );
    const afterDelete = await handler(
      "manage.experts.list",
      { scope: "project", cwd: workDir },
      new AbortController().signal,
    );
    assertEquals(
      (afterDelete as { experts: { name: string }[] }).experts.some((item) =>
        item.name === "core-expert"
      ),
      false,
    );
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

test("production Core settings patch persists allowed defaults", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "opensac-core-settings-" });
  const previous = Deno.env.get("OPENSAC_DIR");
  Deno.env.set("OPENSAC_DIR", workDir);
  try {
    const settings = defaultSettings();
    settings.sessionDir = join(workDir, "sessions");
    const handler = createProductionCoreExtensionHandler(settings);
    const result = await handler(
      "manage.settings.patch",
      { patch: { defaultMode: "plan", defaultModel: "patched-model" } },
      new AbortController().signal,
    );
    assertEquals((result as { defaultMode: string }).defaultMode, "plan");
    const raw = JSON.parse(
      Deno.readTextFileSync(join(workDir, "settings.json")),
    );
    assertEquals(raw.defaultMode, "plan");
    assertEquals(raw.defaultModel, "patched-model");
  } finally {
    if (previous === undefined) Deno.env.delete("OPENSAC_DIR");
    else Deno.env.set("OPENSAC_DIR", previous);
    await Deno.remove(workDir, { recursive: true });
  }
});

test("production Core stats summary returns an empty aggregate without stats DB", async () => {
  const workDir = await Deno.makeTempDir({
    prefix: "opensac-core-stats-summary-",
  });
  try {
    const settings = defaultSettings();
    settings.sessionDir = join(workDir, "sessions");
    const handler = createProductionCoreExtensionHandler(settings);
    const result = await handler(
      "manage.stats.summary",
      { from: "2026-01-01T00:00:00.000Z" },
      new AbortController().signal,
    );
    assertEquals(result, {
      sessions: 0,
      runs: 0,
      tokens: { input: 0, output: 0, total: 0 },
      cost: 0,
      since: "2026-01-01T00:00:00.000Z",
    });
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

test("production Core stats timeseries returns an empty series without stats DB", async () => {
  const workDir = await Deno.makeTempDir({
    prefix: "opensac-core-stats-series-",
  });
  try {
    const settings = defaultSettings();
    settings.sessionDir = join(workDir, "sessions");
    const handler = createProductionCoreExtensionHandler(settings);
    const result = await handler(
      "manage.stats.timeseries",
      { from: "2026-01-01T00:00:00.000Z", group: "day" },
      new AbortController().signal,
    );
    assertEquals(result, {
      group: "day",
      points: [],
      from: "2026-01-01T00:00:00.000Z",
    });
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

test("production Core memory get and put round trip", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "opensac-core-memory-" });
  const previous = Deno.env.get("OPENSAC_DIR");
  Deno.env.set("OPENSAC_DIR", workDir);
  try {
    const projectDir = join(workDir, "project");
    await Deno.mkdir(projectDir, { recursive: true });
    const settings = defaultSettings();
    settings.sessionDir = join(workDir, "sessions");
    const handler = createProductionCoreExtensionHandler(settings);
    const memoryPath = join(workDir, "memory.md");

    assertEquals(
      await handler(
        "manage.memory.get",
        { cwd: projectDir },
        new AbortController().signal,
      ),
      {
        content: "",
        path: memoryPath,
        source: "explicit",
        size: 0,
        updatedAt: "",
      },
    );
    assertEquals(
      await handler(
        "manage.memory.put",
        { cwd: projectDir, content: "# Memory\n\nhello" },
        new AbortController().signal,
      ),
      {
        size: 15,
        updatedAt: (await Deno.stat(memoryPath)).mtime?.toISOString() ?? "",
        path: memoryPath,
        source: "explicit",
      },
    );
    const read = await handler(
      "manage.memory.get",
      { cwd: projectDir },
      new AbortController().signal,
    ) as {
      content: string;
      path: string;
      source: string;
      size: number;
      updatedAt: string;
    };
    assertEquals(read, {
      content: "# Memory\n\nhello",
      path: memoryPath,
      source: "explicit",
      size: 15,
      updatedAt: (await Deno.stat(memoryPath)).mtime?.toISOString() ?? "",
    });
    await assertRejects(
      () =>
        handler(
          "manage.memory.put",
          { cwd: projectDir, content: "x".repeat((1 << 20) + 1) },
          new AbortController().signal,
        ),
      Error,
      "memory content exceeds the 1048576 byte limit",
    );
  } finally {
    if (previous === undefined) Deno.env.delete("OPENSAC_DIR");
    else Deno.env.set("OPENSAC_DIR", previous);
    await Deno.remove(workDir, { recursive: true });
  }
});

test("production Core knowledge bases create/list/get/update/delete", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "opensac-core-knowledge-" });
  try {
    const rootDir = join(workDir, "docs");
    await Deno.mkdir(rootDir, { recursive: true });
    const settings = defaultSettings();
    settings.sessionDir = join(workDir, "sessions");
    const handler = createProductionCoreExtensionHandler(settings);
    const created = await handler(
      "manage.knowledge-bases.create",
      {
        knowledgeBase: {
          name: "Docs",
          rootDir,
          preprocessProfile: "documents",
          provider: "",
          model: "",
          mode: "",
          thinkingLevel: "",
          schedule: "daily",
          enabled: true,
        },
      },
      new AbortController().signal,
    ) as { knowledgeBase: { id: string; name: string }; status: string };
    const id = created.knowledgeBase.id;
    assertEquals(created.knowledgeBase.name, "Docs");
    assertEquals(created.status, "unindexed");
    const cronStore = createSQLiteCronStore(settings.sessionDir);
    assertEquals(
      cronStore.get(knowledgeBaseCronJobID(id)).schedule,
      "@daily",
    );

    const listed = await handler(
      "manage.knowledge-bases.list",
      {},
      new AbortController().signal,
    ) as { knowledgeBases: { knowledgeBase: { id: string } }[] };
    assertEquals(listed.knowledgeBases.map((item) => item.knowledgeBase.id), [
      id,
    ]);

    const updated = await handler(
      "manage.knowledge-bases.update",
      {
        id,
        knowledgeBase: {
          name: "Reference",
          rootDir,
          preprocessProfile: "documents",
          provider: "",
          model: "",
          mode: "",
          thinkingLevel: "",
          schedule: "manual",
          enabled: true,
        },
      },
      new AbortController().signal,
    ) as { knowledgeBase: { id: string; name: string } };
    assertEquals(updated.knowledgeBase.id, id);
    assertEquals(updated.knowledgeBase.name, "Reference");
    await assertRejects(async () => cronStore.get(knowledgeBaseCronJobID(id)));

    assertEquals(
      await handler(
        "manage.knowledge-bases.delete",
        { id },
        new AbortController().signal,
      ),
      { id, deleted: true },
    );
    assertEquals(
      (await handler(
        "manage.knowledge-bases.list",
        {},
        new AbortController().signal,
      )) as { knowledgeBases: unknown[] },
      { knowledgeBases: [] },
    );
  } finally {
    closeDatabases();
    await Deno.remove(workDir, { recursive: true });
  }
});

test("production Core knowledge scan starts a cached background index", async () => {
  const workDir = await Deno.makeTempDir({
    prefix: "opensac-core-knowledge-scan-",
  });
  try {
    const rootDir = join(workDir, "docs");
    await Deno.mkdir(rootDir, { recursive: true });
    await Deno.writeTextFile(join(rootDir, "readme.md"), "# Readme\n");
    const settings = defaultSettings();
    settings.sessionDir = join(workDir, "sessions");
    let service: ReturnType<typeof createKnowledgeBaseService> | undefined;
    const handler = createProductionCoreExtensionHandler(settings, {
      knowledgeServiceFactory: (currentSettings) =>
        service ??= createKnowledgeBaseService(
          currentSettings.sessionDir ?? "",
          defaultKnowledgeBaseIndexPolicy(),
          currentSettings,
        ),
    });
    const created = await handler(
      "manage.knowledge-bases.create",
      {
        knowledgeBase: {
          name: "Docs",
          rootDir,
          preprocessProfile: "documents",
          provider: "",
          model: "",
          mode: "",
          thinkingLevel: "",
          schedule: "manual",
          enabled: true,
        },
      },
      new AbortController().signal,
    ) as { knowledgeBase: { id: string } };
    const id = created.knowledgeBase.id;
    const scan = await handler(
      "manage.knowledge-bases.scan",
      { id },
      new AbortController().signal,
    ) as { started: boolean; alreadyRunning: boolean; status: string };
    assertEquals(scan.started, true);
    assertEquals(scan.alreadyRunning, false);
    assertEquals(scan.status, "indexing");
    const status = await handler(
      "manage.knowledge-bases.status",
      { id },
      new AbortController().signal,
    ) as { knowledgeBase: { id: string } };
    assertEquals(status.knowledgeBase.id, id);
    await service?.indexJob(id)?.done();
  } finally {
    closeDatabases();
    await Deno.remove(workDir, { recursive: true });
  }
});

test("production Core knowledge query requires an indexed base", async () => {
  const workDir = await Deno.makeTempDir({
    prefix: "opensac-core-knowledge-query-",
  });
  try {
    const rootDir = join(workDir, "docs");
    await Deno.mkdir(rootDir, { recursive: true });
    const settings = defaultSettings();
    settings.sessionDir = join(workDir, "sessions");
    const handler = createProductionCoreExtensionHandler(settings);
    const created = await handler(
      "manage.knowledge-bases.create",
      {
        knowledgeBase: {
          name: "Docs",
          rootDir,
          preprocessProfile: "documents",
          provider: "",
          model: "",
          mode: "",
          thinkingLevel: "",
          schedule: "manual",
          enabled: true,
        },
      },
      new AbortController().signal,
    ) as { knowledgeBase: { id: string } };
    await assertRejects(
      () =>
        handler(
          "manage.knowledge-bases.query",
          { id: created.knowledgeBase.id, query: "readme" },
          new AbortController().signal,
        ),
      Error,
      "knowledge base has no completed index",
    );
  } finally {
    closeDatabases();
    await Deno.remove(workDir, { recursive: true });
  }
});

test("production Core knowledge MCP apply writes the canonical server", async () => {
  const workDir = await Deno.makeTempDir({
    prefix: "opensac-core-knowledge-mcp-",
  });
  const previous = Deno.env.get("OPENSAC_DIR");
  Deno.env.set("OPENSAC_DIR", workDir);
  try {
    const rootDir = join(workDir, "docs");
    await Deno.mkdir(rootDir, { recursive: true });
    const settings = defaultSettings();
    settings.sessionDir = join(workDir, "sessions");
    const handler = createProductionCoreExtensionHandler(settings);
    const created = await handler(
      "manage.knowledge-bases.create",
      {
        knowledgeBase: {
          name: "Docs",
          rootDir,
          preprocessProfile: "documents",
          provider: "",
          model: "",
          mode: "",
          thinkingLevel: "",
          schedule: "manual",
          enabled: true,
        },
      },
      new AbortController().signal,
    ) as { knowledgeBase: { id: string } };
    const id = created.knowledgeBase.id;
    assertEquals(
      await handler(
        "manage.knowledge-bases.mcp.apply",
        { id, enabled: true },
        new AbortController().signal,
      ),
      { id, name: `knowledge-${id}`, enabled: true },
    );
    const config = JSON.parse(
      Deno.readTextFileSync(join(workDir, "mcp.json")),
    );
    assertEquals(config.mcpServers[0].name, `knowledge-${id}`);
    assertEquals(config.mcpServers[0].enabled, true);
  } finally {
    if (previous === undefined) Deno.env.delete("OPENSAC_DIR");
    else Deno.env.set("OPENSAC_DIR", previous);
    closeDatabases();
    await Deno.remove(workDir, { recursive: true });
  }
});

test("production Core SkillHub settings stay secret-safe across patch", async () => {
  const workDir = await Deno.makeTempDir({
    prefix: "opensac-core-skillhub-settings-",
  });
  const previous = Deno.env.get("OPENSAC_DIR");
  Deno.env.set("OPENSAC_DIR", workDir);
  try {
    const settings = defaultSettings();
    settings.skillHub = {
      defaultMarket: "custom.market",
      defaultInstallScope: "global",
      officialHandles: ["alice"],
      markets: [{
        id: "custom.market",
        name: "Custom Market",
        siteURL: "https://example.test",
        apiURL: "https://api.example.test",
        enabled: true,
        apiToken: "skillhub-secret",
        customField: "preserve-me",
      }] as never,
    };
    await Deno.writeTextFile(
      join(workDir, "settings.json"),
      JSON.stringify(settings),
    );
    const handler = createProductionCoreExtensionHandler(settings);
    const view = await handler(
      "manage.skillhub.get",
      {},
      new AbortController().signal,
    ) as { markets: Record<string, unknown>[] };
    assertEquals(view.markets[0].apiTokenConfigured, true);
    assertEquals("apiToken" in view.markets[0], false);

    const patched = await handler(
      "manage.skillhub.patch",
      {
        patch: {
          defaultInstallScope: "project",
          markets: [{ id: "custom.market", name: "Renamed Market" }],
        },
      },
      new AbortController().signal,
    ) as { markets: Record<string, unknown>[] };
    assertEquals(patched.markets[0].apiTokenConfigured, true);
    assertEquals("apiToken" in patched.markets[0], false);
    const raw = JSON.parse(
      Deno.readTextFileSync(join(workDir, "settings.json")),
    );
    assertEquals(raw.skillHub.defaultInstallScope, "project");
    assertEquals(raw.skillHub.markets[0].name, "Renamed Market");
    assertEquals(raw.skillHub.markets[0].apiToken, "skillhub-secret");
    assertEquals(raw.skillHub.markets[0].customField, "preserve-me");
    const refreshed = await handler(
      "manage.skillhub.get",
      {},
      new AbortController().signal,
    ) as { markets: Record<string, unknown>[] };
    assertEquals(refreshed.markets[0].name, "Renamed Market");
  } finally {
    if (previous === undefined) Deno.env.delete("OPENSAC_DIR");
    else Deno.env.set("OPENSAC_DIR", previous);
    await Deno.remove(workDir, { recursive: true });
  }
});

test("production Core SkillHub markets project the Core catalog", async () => {
  const workDir = await Deno.makeTempDir({
    prefix: "opensac-core-skillhub-catalog-",
  });
  try {
    const settings = defaultSettings();
    settings.sessionDir = join(workDir, "sessions");
    const handler = createProductionCoreExtensionHandler(settings);
    const result = await handler(
      "manage.skillhub.markets",
      { sessionId: "session-1" },
      new AbortController().signal,
    ) as { defaultMarket: string; markets: { id: string }[] };
    assertEquals(result.defaultMarket, "skillhub.cn");
    assertEquals(result.markets.map((market) => market.id), [
      "clawhub.ai",
      "skillhub.cn",
    ]);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

test("production Core SkillHub mutations delegate to the Core service", async () => {
  const workDir = await Deno.makeTempDir({
    prefix: "opensac-core-skillhub-mutation-",
  });
  const calls: string[] = [];
  const service = {
    install: (
      _signal: AbortSignal,
      request: { id: string; targetDir: string },
    ) => {
      calls.push(`install:${request.id}:${request.targetDir}`);
      return Promise.resolve({ name: request.id } as never);
    },
    uninstall: (market: string, id: string, scope: string) => {
      calls.push(`uninstall:${market}:${id}:${scope}`);
    },
  } as unknown as SkillHubService;
  try {
    const settings = defaultSettings();
    settings.sessionDir = join(workDir, "sessions");
    const handler = createProductionCoreExtensionHandler(settings, {
      skillHubServiceFactory: () => service,
      setSessionSkill: async (sessionId, name, active) => {
        calls.push(`skill:${sessionId}:${name}:${active}`);
        return { sessionId, workDir, activeSkills: active ? [name] : [] };
      },
    });
    const installed = await handler(
      "manage.skillhub.install",
      {
        id: "demo",
        sessionId: "session-1",
        targetDir: join(workDir, "skills"),
        scope: "project",
        activate: true,
      },
      new AbortController().signal,
    ) as { install: { name: string }; activated: boolean };
    assertEquals(installed.install.name, "demo");
    assertEquals(installed.activated, true);
    const uninstalled = await handler(
      "manage.skillhub.uninstall",
      {
        market: "skillhub.cn",
        id: "demo",
        sessionId: "session-1",
        scope: "project",
      },
      new AbortController().signal,
    );
    assertEquals(uninstalled, { uninstalled: true });
    assertEquals(calls, [
      `install:demo:${join(workDir, "skills")}`,
      "skill:session-1:demo:true",
      "uninstall:skillhub.cn:demo:project",
    ]);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

test("production Core cron run delegates execution to the Core runner", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "opensac-core-cron-run-" });
  try {
    const settings = defaultSettings();
    settings.sessionDir = join(workDir, "sessions");
    let triggered = "";
    const handler = createProductionCoreExtensionHandler(settings, {
      runCronJob: async (job: { id?: string }) => {
        triggered = job.id ?? "";
        return "done";
      },
    } as never);
    const created = await handler(
      "manage.cron.create",
      { name: "Run me", prompt: "Do work", schedule: "@daily", mode: "yolo" },
      new AbortController().signal,
    ) as { job: { id: string } };
    assertEquals(
      await handler(
        "manage.cron.run",
        { id: created.job.id },
        new AbortController().signal,
      ),
      { ok: true, jobId: created.job.id, triggered: true },
    );
    assertEquals(triggered, created.job.id);
  } finally {
    closeDatabases();
    await Deno.remove(workDir, { recursive: true });
  }
});

test("production Core cron list/create/update/remove persists jobs", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "opensac-core-cron-" });
  try {
    const settings = defaultSettings();
    settings.sessionDir = join(workDir, "sessions");
    const handler = createProductionCoreExtensionHandler(settings);
    const list = await handler(
      "manage.cron.list",
      {},
      new AbortController().signal,
    ) as {
      enabled: boolean;
      running: boolean;
      jobs: Record<string, unknown>[];
    };
    assertEquals(list, { enabled: true, running: false, jobs: [] });

    const created = await handler(
      "manage.cron.create",
      {
        name: "Daily report",
        prompt: "Summarize the project",
        schedule: "@daily",
        mode: "yolo",
        enabled: true,
      },
      new AbortController().signal,
    ) as { job: Record<string, unknown> };
    const jobID = created.job.id as string;
    assertEquals(created.job.name, "Daily report");
    assertEquals(created.job.schedule, "@daily");
    assertEquals(created.job.mode, "yolo");
    assertEquals(created.job.enabled, true);

    const updated = await handler(
      "manage.cron.update",
      { id: jobID, prompt: "Summarize yesterday" },
      new AbortController().signal,
    ) as { job: Record<string, unknown> };
    assertEquals(updated.job.id, jobID);
    assertEquals(updated.job.prompt, "Summarize yesterday");

    assertEquals(
      await handler(
        "manage.cron.remove",
        { id: jobID },
        new AbortController().signal,
      ),
      { id: jobID, deleted: true },
    );
    const listed = await handler(
      "manage.cron.list",
      {},
      new AbortController().signal,
    ) as {
      enabled: boolean;
      running: boolean;
      jobs: Record<string, unknown>[];
    };
    assertEquals(listed, { enabled: true, running: false, jobs: [] });
  } finally {
    closeDatabases();
    await Deno.remove(workDir, { recursive: true });
  }
});

test("production Core deliveries list and retry failed operations", async () => {
  const workDir = await Deno.makeTempDir({
    prefix: "opensac-core-deliveries-",
  });
  try {
    const settings = defaultSettings();
    settings.sessionDir = join(workDir, "sessions");
    const seeded = seedFailedDelivery(
      settings.sessionDir,
      "delivery_retries_exhausted",
    );
    const handler = createProductionCoreExtensionHandler(settings);
    const listed = await handler(
      "manage.deliveries.list",
      { sessionId: seeded.sessionId },
      new AbortController().signal,
    ) as { deliveries: Record<string, unknown>[]; count: number };
    assertEquals(listed.count, 1);
    assertEquals(listed.deliveries[0].operationId, seeded.operationId);
    assertEquals(listed.deliveries[0].retryable, true);
    assertEquals("payload" in listed.deliveries[0], false);
    assertEquals(
      await handler(
        "manage.deliveries.retry",
        { operationId: seeded.operationId },
        new AbortController().signal,
      ),
      { operationId: seeded.operationId, retried: true },
    );
    assertEquals(
      getDeliveryOperation(settings.sessionDir, seeded.operationId)!.status,
      "retry_wait",
    );
  } finally {
    closeDatabases();
    await Deno.remove(workDir, { recursive: true });
  }
});

test("production Core MCP set replaces servers without leaking secrets", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "opensac-core-mcp-set-" });
  const previous = Deno.env.get("OPENSAC_DIR");
  Deno.env.set("OPENSAC_DIR", workDir);
  try {
    const settings = defaultSettings();
    settings.sessionDir = join(workDir, "sessions");
    const handler = createProductionCoreExtensionHandler(settings);
    const result = await handler(
      "manage.mcp.set",
      {
        scope: "global",
        servers: [{
          name: "remote",
          type: "http",
          url: "https://mcp.example/rpc",
          headers: [{ name: "Authorization", value: "Bearer mcp-secret" }],
          env: [{ name: "MCP_TOKEN", value: "env-secret" }],
        }],
      },
      new AbortController().signal,
    );
    assertEquals(result, {
      scope: "global",
      sessionId: "",
      path: join(workDir, "mcp.json"),
      servers: [{
        name: "remote",
        type: "http",
        enabled: true,
        url: "https://mcp.example/rpc",
        headers: [{ name: "Authorization", valueConfigured: true }],
        env: [{ name: "MCP_TOKEN", valueConfigured: true }],
      }],
    });
    assertEquals(JSON.stringify(result).includes("mcp-secret"), false);
    assertEquals(JSON.stringify(result).includes("env-secret"), false);
    const raw = JSON.parse(
      Deno.readTextFileSync(join(workDir, "mcp.json")),
    );
    assertEquals(raw.mcpServers[0].headers[0].value, "Bearer mcp-secret");
    assertEquals(raw.mcpServers[0].env[0].value, "env-secret");
  } finally {
    if (previous === undefined) Deno.env.delete("OPENSAC_DIR");
    else Deno.env.set("OPENSAC_DIR", previous);
    await Deno.remove(workDir, { recursive: true });
  }
});

test("production Core MCP list projects global configuration", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "opensac-core-mcp-list-" });
  const previous = Deno.env.get("OPENSAC_DIR");
  Deno.env.set("OPENSAC_DIR", workDir);
  try {
    await Deno.writeTextFile(
      join(workDir, "mcp.json"),
      JSON.stringify({
        mcpServers: [{
          name: "files",
          type: "stdio",
          command: "file-server",
          args: ["--root", "/tmp"],
          enabled: true,
        }],
      }),
    );
    const settings = defaultSettings();
    settings.sessionDir = join(workDir, "sessions");
    const handler = createProductionCoreExtensionHandler(settings);
    const result = await handler(
      "manage.mcp.list",
      { scope: "global" },
      new AbortController().signal,
    );
    assertEquals(result, {
      scope: "global",
      sessionId: "",
      path: join(workDir, "mcp.json"),
      servers: [{
        name: "files",
        type: "stdio",
        enabled: true,
        command: "file-server",
        args: ["--root", "/tmp"],
      }],
    });
  } finally {
    if (previous === undefined) Deno.env.delete("OPENSAC_DIR");
    else Deno.env.set("OPENSAC_DIR", previous);
    await Deno.remove(workDir, { recursive: true });
  }
});

test("production Core skills list projects shared skill state", async () => {
  const workDir = await Deno.makeTempDir({
    prefix: "opensac-core-skills-list-",
  });
  try {
    const projectDir = join(workDir, "project");
    const skillDir = join(projectDir, ".opensac", "skills", "alpha");
    await Deno.mkdir(skillDir, { recursive: true });
    await Deno.writeTextFile(join(skillDir, "SKILL.md"), "# Alpha\n");
    const settings = defaultSettings();
    settings.sessionDir = join(workDir, "sessions");
    settings.skillsDir = join(workDir, "global-skills");
    const handler = createProductionCoreExtensionHandler(settings);
    const result = await handler(
      "manage.skills.list",
      { cwd: projectDir },
      new AbortController().signal,
    );
    const view = result as {
      cwd: string;
      skills: {
        name: string;
        description: string;
        source: string;
        enabled: boolean;
      }[];
    };
    assertEquals(view.cwd, projectDir);
    assertEquals(view.skills.find((skill) => skill.name === "alpha"), {
      name: "alpha",
      description: "Alpha",
      source: "project",
      enabled: true,
    });
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

test("production Core skills set persists disabled state", async () => {
  const workDir = await Deno.makeTempDir({
    prefix: "opensac-core-skills-set-",
  });
  const previous = Deno.env.get("OPENSAC_DIR");
  Deno.env.set("OPENSAC_DIR", workDir);
  try {
    const projectDir = join(workDir, "project");
    const skillDir = join(projectDir, ".opensac", "skills", "alpha");
    await Deno.mkdir(skillDir, { recursive: true });
    await Deno.writeTextFile(join(skillDir, "SKILL.md"), "# Alpha\n");
    const settings = defaultSettings();
    settings.sessionDir = join(workDir, "sessions");
    settings.skillsDir = join(workDir, "global-skills");
    const handler = createProductionCoreExtensionHandler(settings);
    const result = await handler(
      "manage.skills.set",
      { cwd: projectDir, name: "alpha", enabled: false },
      new AbortController().signal,
    );
    assertEquals(result, {
      name: "alpha",
      enabled: false,
      skillsDisabled: ["alpha"],
    });
    const raw = JSON.parse(
      Deno.readTextFileSync(join(workDir, "settings.json")),
    );
    assertEquals(raw.skills.disabled, ["alpha"]);
  } finally {
    if (previous === undefined) Deno.env.delete("OPENSAC_DIR");
    else Deno.env.set("OPENSAC_DIR", previous);
    await Deno.remove(workDir, { recursive: true });
  }
});

test("production Core application get returns a secret-safe settings view", async () => {
  const settings = defaultSettings();
  settings.defaultMode = "plan";
  settings.enablePlanTool = true;
  settings.contextFiles = { enabled: true, extraFiles: ["AGENTS.md"] };
  settings.imageGeneration = {
    enabled: true,
    provider: "openai",
    apiType: "openai-images",
    baseUrl: "https://images.example/v1",
    model: "image-model",
    token: "secret-image-token",
  };
  const handler = createProductionCoreExtensionHandler(settings);
  const result = await handler(
    "manage.application.get",
    {},
    new AbortController().signal,
  );
  const view = result as {
    defaults: {
      defaultMode: string;
      enablePlanTool: boolean;
      enableArtifact: boolean;
      enableACPArtifact: boolean;
      authored: boolean;
      updateCheck: boolean;
    };
    contextFiles: { enabled: boolean; extraFiles: string[] };
    imageGeneration: { tokenConfigured: boolean };
  };
  assertEquals(view.defaults, {
    defaultMode: "plan",
    enablePlanTool: true,
    enableArtifact: false,
    enableACPArtifact: false,
    authored: false,
    updateCheck: true,
  });
  assertEquals(view.contextFiles, {
    enabled: true,
    extraFiles: ["AGENTS.md"],
  });
  assertEquals(view.imageGeneration.tokenConfigured, true);
  assertEquals(JSON.stringify(result).includes("secret-image-token"), false);
});

test("production Core application patch persists allowed sections", async () => {
  const workDir = await Deno.makeTempDir({
    prefix: "opensac-core-application-patch-",
  });
  const previous = Deno.env.get("OPENSAC_DIR");
  Deno.env.set("OPENSAC_DIR", workDir);
  try {
    const settings = defaultSettings();
    settings.sessionDir = join(workDir, "sessions");
    const handler = createProductionCoreExtensionHandler(settings);
    const result = await handler(
      "manage.application.patch",
      {
        patch: {
          defaults: { defaultMode: "plan", enablePlanTool: true },
          contextFiles: { enabled: true, extraFiles: ["AGENTS.md"] },
        },
      },
      new AbortController().signal,
    );
    const view = result as {
      defaults: { defaultMode: string; enablePlanTool: boolean };
      contextFiles: { enabled: boolean; extraFiles: string[] };
    };
    assertEquals(view.defaults.defaultMode, "plan");
    assertEquals(view.defaults.enablePlanTool, true);
    assertEquals(view.contextFiles, {
      enabled: true,
      extraFiles: ["AGENTS.md"],
    });
    const raw = JSON.parse(
      Deno.readTextFileSync(join(workDir, "settings.json")),
    );
    assertEquals(raw.defaultMode, "plan");
    assertEquals(raw.enablePlanTool, true);
    assertEquals(raw.contextFiles, {
      enabled: true,
      extraFiles: ["AGENTS.md"],
    });
  } finally {
    if (previous === undefined) Deno.env.delete("OPENSAC_DIR");
    else Deno.env.set("OPENSAC_DIR", previous);
    await Deno.remove(workDir, { recursive: true });
  }
});

test("production Core provider discovery uses the Core provider boundary", async () => {
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0 },
    (request) => {
      const url = new URL(request.url);
      if (url.pathname !== "/v1/models") {
        return new Response("not found", { status: 404 });
      }
      if (request.headers.get("authorization") !== "Bearer discover-secret") {
        return new Response("unauthorized", { status: 401 });
      }
      return Response.json({
        data: [{
          id: "discovered-model",
          name: "Discovered Model",
          context_length: 64000,
          max_output_tokens: 8192,
          input: ["text", "image"],
        }],
      });
    },
  );
  try {
    const settings = defaultSettings();
    const handler = createProductionCoreExtensionHandler(settings);
    const result = await handler(
      "manage.providers.discover",
      {
        api: "openai-chat",
        baseUrl: `http://127.0.0.1:${server.addr.port}/v1`,
        apiKey: "discover-secret",
      },
      new AbortController().signal,
    );
    assertEquals(result, {
      models: [{
        id: "discovered-model",
        name: "Discovered Model",
        contextWindow: 64000,
        maxTokens: 8192,
        input: ["text", "image"],
      }],
    });
    assertEquals(JSON.stringify(result).includes("discover-secret"), false);
  } finally {
    await server.shutdown();
  }
});

test("production Core provider test pings through the Core provider factory", async () => {
  const model = {
    id: "fake-model",
    name: "Fake",
    provider: "fake",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 1000,
  };
  const provider = {
    chat: async function* () {
      yield { type: 6 };
    },
    name: () => "fake",
    api: () => "fake",
    models: () => [model],
    getModel: () => model,
  };
  const settings = defaultSettings();
  const createHandler = createProductionCoreExtensionHandler as unknown as (
    settings: Settings,
    options: { createProvider: typeof createFactoryProvider },
  ) => CoreExtensionHandler;
  const handler = createHandler(settings, {
    createProvider: () => ({ provider, model }),
  });
  const result = await handler(
    "manage.providers.test",
    { provider: "fake", model: "fake-model" },
    new AbortController().signal,
  ) as {
    ok: boolean;
    provider: string;
    model: string;
    latencyMs: number;
  };
  assertEquals(result.ok, true);
  assertEquals(result.provider, "fake");
  assertEquals(result.model, "fake-model");
  assertEquals(result.latencyMs >= 0, true);
});

test("production Core provider save persists a secret-safe catalog", async () => {
  const workDir = await Deno.makeTempDir({
    prefix: "opensac-core-provider-save-",
  });
  const previous = Deno.env.get("OPENSAC_DIR");
  Deno.env.set("OPENSAC_DIR", workDir);
  try {
    const settings = defaultSettings();
    settings.sessionDir = join(workDir, "sessions");
    settings.providers = {};
    const handler = createProductionCoreExtensionHandler(settings);
    const result = await handler(
      "manage.providers.save",
      {
        id: "custom",
        apiKey: "secret-custom-key",
        provider: {
          api: "openai-chat",
          models: [{ id: "custom-model", name: "Custom" }],
        },
      },
      new AbortController().signal,
    );
    const custom = (result as {
      providers: {
        name: string;
        modelCount: number;
        maskedKey: string;
        apiKeyConfigured: boolean;
        models?: { id: string; name: string }[];
      }[];
    }).providers.find((provider) => provider.name === "custom");
    assertEquals(custom, {
      name: "custom",
      modelCount: 1,
      models: [{ id: "custom-model", name: "Custom" }],
      maskedKey: "sec***key",
      apiKeyConfigured: true,
    });
    const raw = JSON.parse(
      Deno.readTextFileSync(join(workDir, "settings.json")),
    );
    assertEquals(raw.providers.custom.apiKey, "secret-custom-key");
    assertEquals(JSON.stringify(result).includes("secret-custom-key"), false);
  } finally {
    if (previous === undefined) Deno.env.delete("OPENSAC_DIR");
    else Deno.env.set("OPENSAC_DIR", previous);
    await Deno.remove(workDir, { recursive: true });
  }
});

test("production Core provider delete removes a global override", async () => {
  const workDir = await Deno.makeTempDir({
    prefix: "opensac-core-provider-delete-",
  });
  const previous = Deno.env.get("OPENSAC_DIR");
  Deno.env.set("OPENSAC_DIR", workDir);
  try {
    Deno.writeTextFileSync(
      join(workDir, "settings.json"),
      JSON.stringify({
        providers: {
          custom: {
            api: "openai-chat",
            models: [{ id: "custom-model" }],
          },
        },
      }),
    );
    const settings = defaultSettings();
    settings.sessionDir = join(workDir, "sessions");
    settings.defaultProvider = "keep";
    const handler = createProductionCoreExtensionHandler(settings);
    const result = await handler(
      "manage.providers.delete",
      { id: "custom" },
      new AbortController().signal,
    );
    assertEquals(
      (result as { providers: { name: string }[] }).providers.some((provider) =>
        provider.name === "custom"
      ),
      false,
    );
    const raw = JSON.parse(
      Deno.readTextFileSync(join(workDir, "settings.json")),
    );
    assertEquals(raw.providers.custom, undefined);
  } finally {
    if (previous === undefined) Deno.env.delete("OPENSAC_DIR");
    else Deno.env.set("OPENSAC_DIR", previous);
    await Deno.remove(workDir, { recursive: true });
  }
});

test("Core Runtime Host forwards reverse-request transport to session runtimes", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "opensac-core-reverse-" });
  let received: unknown;
  try {
    const host = await createCoreRuntimeHost({
      source: SOURCE_ACP,
      workDir,
      settings: defaultSettings(),
      providerName: "test-provider",
      modelID: "test-model",
      reverseRequest: () =>
        Promise.resolve({ jsonrpc: "2.0" as const, id: null, result: null }),
      dependencies: {
        createSessionRuntime: (input) => {
          received = input.reverseRequest;
          return new FakeSessionRuntime(input.sessionId);
        },
      },
    });
    await host.createSession({ workDir });
    assertEquals(typeof received, "function");
    await host.close();
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

test("Core Runtime Host opens a persisted session through its factory", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "opensac-core-open-" });
  const opened: string[] = [];
  try {
    const host = await createCoreRuntimeHost({
      source: SOURCE_ACP,
      workDir,
      settings: defaultSettings(),
      providerName: "test-provider",
      modelID: "test-model",
      dependencies: {
        createSessionRuntime: (input) =>
          new FakeSessionRuntime(input.sessionId),
        openSessionRuntime: (input) => {
          opened.push(input.sessionId);
          return new FakeSessionRuntime(input.sessionId);
        },
      },
    });
    const session = await host.openSession({ sessionId: "persisted-1" });
    assertEquals(session.sessionId, "persisted-1");
    assertEquals(opened, ["persisted-1"]);
    await host.close();
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

test("Core Runtime Host creates, prompts, cancels, and closes one session runtime", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "opensac-core-host-" });
  const created: FakeSessionRuntime[] = [];
  const options: CoreRuntimeHostOptions = {
    source: SOURCE_ACP,
    workDir,
    settings: defaultSettings(),
    providerName: "test-provider",
    modelID: "test-model",
    dependencies: {
      newId: () => `session-${created.length + 1}`,
      createSessionRuntime: () => {
        const runtime = new FakeSessionRuntime(`session-${created.length + 1}`);
        created.push(runtime);
        return runtime;
      },
    },
  };

  try {
    const host = await createCoreRuntimeHost(options);
    const session = await host.createSession({ workDir });
    assertEquals(session.sessionId, "session-1");
    assertEquals(created.length, 1);

    const accepted = await host.prompt({
      sessionId: session.sessionId,
      text: "hello",
    });
    assertEquals(accepted.runId, "session-1-run");
    assertEquals(created[0].events, ["prompt:hello"]);

    const events = host.subscribeRunEvents(
      session.sessionId,
      accepted.runId,
    );
    const first = await events.next();
    assertEquals(first.done, false);
    if (first.done) throw new Error("expected a runtime event");
    assertEquals(first.value.eventType, "run_started");
    assertEquals(first.value.sequence, 1);

    await host.cancelRun({
      sessionId: session.sessionId,
      runId: accepted.runId,
    });
    assertEquals(created[0].cancelled, [accepted.runId]);

    await host.closeSession({ sessionId: session.sessionId });
    assertEquals(created[0].closed, true);
    await host.close();
    await host.close();
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

test("Core Runtime Host reuses the runtime for a session opened again", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "opensac-core-host-" });
  const created: FakeSessionRuntime[] = [];

  try {
    const host = await createCoreRuntimeHost({
      source: SOURCE_ACP,
      workDir,
      settings: defaultSettings(),
      providerName: "test-provider",
      modelID: "test-model",
      dependencies: {
        createSessionRuntime: () => {
          const runtime = new FakeSessionRuntime(
            `session-${created.length + 1}`,
          );
          created.push(runtime);
          return runtime;
        },
      },
    });

    const session = await host.createSession({ workDir });
    const opened = await host.openSession({ sessionId: session.sessionId });
    assertEquals(opened.sessionId, session.sessionId);
    assertEquals(created.length, 1);

    await host.close();
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

test("Core Runtime Host routes skill, prepared-input, and capability projections", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "opensac-core-host-" });
  try {
    class CapabilityRuntime extends FakeSessionRuntime {
      skill: { name: string; active: boolean } | undefined;

      setSkillActive(
        input: { name: string; active: boolean },
      ): Promise<void> {
        this.skill = input;
        return Promise.resolve();
      }

      listSkills() {
        return Promise.resolve([{
          name: "review",
          source: "project",
          description: "Review skill",
          active: this.skill?.active === true,
        }]);
      }

      prepareInput(input: { name: string; mediaType: string }) {
        return Promise.resolve({
          resourceId: "resource-1",
          kind: "image",
          relativePath: ".opensac/inputs/resource-1",
          filename: input.name,
          mediaType: input.mediaType,
          bytes: 2,
        });
      }

      capabilityView() {
        return Promise.resolve({
          sandbox: { enabled: true, available: true },
        });
      }
    }
    const created: CapabilityRuntime[] = [];
    const host = await createCoreRuntimeHost({
      source: SOURCE_ACP,
      workDir,
      settings: defaultSettings(),
      providerName: "test-provider",
      modelID: "test-model",
      dependencies: {
        createSessionRuntime: (input) => {
          const runtime = new CapabilityRuntime(input.sessionId);
          created.push(runtime);
          return runtime;
        },
      },
    });
    const session = await host.createSession({ workDir });

    assertEquals(
      await host.listSessionSkills({
        sessionId: session.sessionId,
      }),
      [{
        name: "review",
        source: "project",
        description: "Review skill",
        active: false,
      }],
    );
    await host.setSessionSkill?.({
      sessionId: session.sessionId,
      name: "review",
      active: true,
    });
    assertEquals(created[0].skill, { name: "review", active: true });
    assertEquals(
      await host.listSessionSkills({
        sessionId: session.sessionId,
      }),
      [{
        name: "review",
        source: "project",
        description: "Review skill",
        active: true,
      }],
    );

    assertEquals(
      await host.prepareInput({
        sessionId: session.sessionId,
        name: "clipboard.png",
        mediaType: "image/png",
        contentBase64: "aGk=",
      }),
      {
        resourceId: "resource-1",
        kind: "image",
        relativePath: ".opensac/inputs/resource-1",
        filename: "clipboard.png",
        mediaType: "image/png",
        bytes: 2,
      },
    );
    assertEquals(
      await host.sessionCapabilities({
        sessionId: session.sessionId,
      }),
      { sandbox: { enabled: true, available: true } },
    );

    await host.close();
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

test("production Core settings, env, and catalog documents round-trip through the host", async () => {
  await withIsolatedConfig(async () => {
    const workDir = await Deno.makeTempDir({ prefix: "opensac-core-docs-" });
    try {
      const settings = defaultSettings();
      settings.sessionDir = join(workDir, "sessions");
      const host = await createCoreRuntimeHost({
        source: SOURCE_ACP,
        workDir,
        settings,
        providerName: "",
        modelID: "",
        dependencies: createProductionCoreRuntimeDependencies(settings),
      });

      // Effective and global documents read fresh from disk.
      const effective = await host.settingsDocument({
        scope: "effective",
        workDir,
      });
      assertEquals(effective.defaultMode, "yolo");
      const global = await host.settingsDocument({ scope: "global" });
      assertEquals(global.defaultProvider, undefined);

      // A sparse global patch persists and refreshes the shared snapshot the
      // Core closures hold (the settings staleness fix).
      const updated = await host.updateSettingsDocument({
        scope: "global",
        updates: {
          defaultProvider: "custom-x",
          defaultModel: "custom-model",
        },
        workDir,
      });
      assertEquals(updated.defaultProvider, "custom-x");
      assertEquals(settings.defaultProvider, "custom-x");

      // Project patches land in the work directory's project settings.
      await host.updateSettingsDocument({
        scope: "project",
        updates: { defaultMode: "agent" },
        workDir,
      });
      assertEquals(
        (await host.settingsDocument({ scope: "effective", workDir }))
          .defaultMode,
        "agent",
      );

      // The catalog covers built-in presets with their resolved models.
      const catalog = await host.providerCatalog({ workDir });
      const preset = catalog.find((entry) => entry.id === "deepseek-openai");
      assert(preset !== undefined);
      assertEquals(preset.isDefault, false);
      assert(preset.models.length > 0);

      // Pair validation resolves through the factory and reports raw causes.
      await host.validateProviderModel({
        providerID: "deepseek-openai",
        modelID: "deepseek-v4-flash",
        workDir,
      });
      const failure = await assertRejects(() =>
        host.validateProviderModel({
          providerID: "nope",
          modelID: "nope",
          workDir,
        })
      );
      assertStringIncludes(
        (failure as Error).message,
        "unknown provider: nope",
      );

      // Env documents replace wholesale: missing names are removed.
      assertEquals(await host.envDocument(), {});
      assertEquals(await host.updateEnvDocument({ vars: { A: "1", B: "2" } }), {
        A: "1",
        B: "2",
      });
      assertEquals(await host.updateEnvDocument({ vars: { B: "3" } }), {
        B: "3",
      });

      await host.close();
    } finally {
      await Deno.remove(workDir, { recursive: true });
    }
  });
});

test("production Core session context updates rule and extra context", async () => {
  await withIsolatedConfig(async () => {
    const workDir = await Deno.makeTempDir({ prefix: "opensac-core-context-" });
    const model: Model = {
      id: "mock-model",
      name: "Mock Model",
      provider: "mock",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 1024,
    };
    const provider = new MockProvider("mock", [model], [
      { type: streamTextDelta, textDelta: "hello" },
      { type: streamDone, stopReason: "end_turn" },
    ]);
    try {
      const settings = defaultSettings();
      settings.sessionDir = join(workDir, "sessions");
      const host = await createCoreRuntimeHost({
        source: SOURCE_ACP,
        workDir,
        settings,
        providerName: "mock",
        modelID: model.id,
        dependencies: createProductionCoreRuntimeDependencies(
          settings,
          () => ({ provider, model }),
        ),
      });
      const session = await host.createSession({ workDir });
      const updated = await host.setSessionContext({
        sessionId: session.sessionId,
        ruleContent: "rules",
        extraContext: "extra",
      });
      assertEquals(updated, { ruleContent: "rules", extraContext: "extra" });
      assertEquals(
        await host.sessionContext({ sessionId: session.sessionId }),
        {
          ruleContent: "rules",
          extraContext: "extra",
        },
      );
      // Absent fields keep their current value.
      const merged = await host.setSessionContext({
        sessionId: session.sessionId,
        extraContext: "more",
      });
      assertEquals(merged, { ruleContent: "rules", extraContext: "more" });
      await host.close();
    } finally {
      await Deno.remove(workDir, { recursive: true });
    }
  });
});

test("production Core expert binding and fork stay Core-owned", async () => {
  await withIsolatedConfig(async () => {
    const workDir = await Deno.makeTempDir({ prefix: "opensac-core-expert-" });
    const model: Model = {
      id: "mock-model",
      name: "Mock Model",
      provider: "mock",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 1024,
    };
    const provider = new MockProvider("mock", [model], [
      { type: streamTextDelta, textDelta: "hello" },
      { type: streamDone, stopReason: "end_turn" },
    ]);
    try {
      const settings = defaultSettings();
      settings.sessionDir = join(workDir, "sessions");
      const host = await createCoreRuntimeHost({
        source: SOURCE_ACP,
        workDir,
        settings,
        providerName: "mock",
        modelID: model.id,
        dependencies: createProductionCoreRuntimeDependencies(
          settings,
          () => ({ provider, model }),
        ),
      });
      const session = await host.createSession({ workDir });

      // Forking needs one completed conversation turn in the source session.
      const accepted = await host.prompt({
        sessionId: session.sessionId,
        text: "hi",
      });
      const drained: CoreRuntimeEvent[] = [];
      for await (
        const event of host.subscribeRunEvents(
          session.sessionId,
          accepted.runId,
        )
      ) {
        drained.push(event);
      }
      assertEquals(drained.at(-1)?.terminal, true);

      // Built-in expert bundles are discoverable through the neutral surface.
      const experts = await host.listExperts({
        sessionId: session.sessionId,
      });
      assert(experts.length > 0);
      const builtin = experts.find((entry) => entry.source === "builtin");
      assert(builtin !== undefined);
      const bundle = await host.inspectExpert({
        sessionId: session.sessionId,
        expertId: builtin.name,
      });
      assertEquals(bundle.name, builtin.name);

      // Binding persists on the session and unbinding clears it.
      assertEquals(
        await host.expertState({ sessionId: session.sessionId }),
        { expertId: "" },
      );
      assertEquals(
        await host.setExpert({
          sessionId: session.sessionId,
          expertId: builtin.name,
        }),
        { expertId: builtin.name },
      );
      const other = experts.find((entry) =>
        entry.name !== builtin.name && entry.invalid !== true
      );
      if (other !== undefined) {
        // Switching one bound expert to another requires a fork.
        await assertRejects(() =>
          host.setExpert({
            sessionId: session.sessionId,
            expertId: other.name,
          })
        );
        // The Core-owned fork applies the expert only to the child branch.
        const child = await host.forkSession({
          sessionId: session.sessionId,
          expertId: other.name,
          titleMode: "",
        });
        assert(child.sessionId !== session.sessionId);
        assertEquals(
          await host.expertState({ sessionId: session.sessionId }),
          { expertId: builtin.name },
        );
        assertEquals(
          await host.expertState({ sessionId: child.sessionId }),
          { expertId: other.name },
        );
      }
      assertEquals(
        await host.setExpert({ sessionId: session.sessionId, expertId: "" }),
        { expertId: "" },
      );
      await host.close();
    } finally {
      await Deno.remove(workDir, { recursive: true });
    }
  });
});

/** Records the tool surface of the latest chat request. */
class RecordingProvider extends MockProvider {
  lastToolNames: string[] = [];

  override async *chat(
    params: import("../provider/types.ts").ChatParams,
  ): AsyncGenerator<import("../provider/types.ts").StreamEvent> {
    this.lastToolNames = (params.tools ?? []).map((tool) => tool.name);
    yield* super.chat(params);
  }
}

/** Holds the chat stream open until the run aborts (long-role simulation). */
class HangingProvider extends MockProvider {
  override async *chat(
    params: import("../provider/types.ts").ChatParams,
  ): AsyncGenerator<import("../provider/types.ts").StreamEvent> {
    await new Promise<void>((resolve) => {
      if (params.abort?.aborted === true) {
        resolve();
        return;
      }
      params.abort?.addEventListener("abort", () => resolve(), { once: true });
    });
    yield {
      type: streamError,
      error: new DOMException("The operation was aborted.", "AbortError"),
    };
  }
}

const CORE_TEST_MODEL: Model = {
  id: "mock-model",
  name: "Mock Model",
  provider: "mock",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 1024,
};

test(
  "production Core delegate toggle registers the blocking tool on the shared registry",
  () =>
    withIsolatedConfig(async () => {
      const workDir = await Deno.makeTempDir({
        prefix: "opensac-core-delegate-",
      });
      const model = CORE_TEST_MODEL;
      const recording = new RecordingProvider("mock", [model], [
        { type: streamTextDelta, textDelta: "hello" },
        { type: streamDone, stopReason: "end_turn" },
      ]);
      try {
        const settings = defaultSettings();
        settings.sessionDir = join(workDir, "sessions");
        const host = await createCoreRuntimeHost({
          source: SOURCE_ACP,
          workDir,
          settings,
          providerName: "mock",
          modelID: model.id,
          dependencies: createProductionCoreRuntimeDependencies(
            settings,
            () => ({ provider: recording, model }),
          ),
        });
        const session = await host.createSession({ workDir });
        assertEquals(
          await host.delegateState({ sessionId: session.sessionId }),
          { enabled: false },
        );
        assertEquals(
          await host.setDelegate({
            sessionId: session.sessionId,
            enabled: true,
          }),
          { enabled: true },
        );
        assertEquals(
          await host.listAgents({ sessionId: session.sessionId }),
          [],
        );

        // The blocking delegate tool joins every prompt's tool surface once
        // enabled and disappears again after disabling.
        const first = await host.prompt({
          sessionId: session.sessionId,
          text: "hi",
        });
        for await (
          const _event of host.subscribeRunEvents(
            session.sessionId,
            first.runId,
          )
        ) {
          // drain
        }
        assert(recording.lastToolNames.includes("delegate_subagent"));

        assertEquals(
          await host.setDelegate({
            sessionId: session.sessionId,
            enabled: false,
          }),
          { enabled: false },
        );
        const second = await host.prompt({
          sessionId: session.sessionId,
          text: "again",
        });
        for await (
          const _event of host.subscribeRunEvents(
            session.sessionId,
            second.runId,
          )
        ) {
          // drain
        }
        assert(!recording.lastToolNames.includes("delegate_subagent"));
        await host.close();
      } finally {
        await Deno.remove(workDir, { recursive: true });
      }
    }),
);

test(
  "production Core ESM supervisor state and continuation are Core-owned",
  () =>
    withIsolatedConfig(async () => {
      const workDir = await Deno.makeTempDir({ prefix: "opensac-core-esm-" });
      const model = CORE_TEST_MODEL;
      const hanging = new HangingProvider("mock", [model], []);
      try {
        const settings = defaultSettings();
        settings.sessionDir = join(workDir, "sessions");
        const host = await createCoreRuntimeHost({
          source: SOURCE_ACP,
          workDir,
          settings,
          providerName: "mock",
          modelID: model.id,
          dependencies: createProductionCoreRuntimeDependencies(
            settings,
            () => ({ provider: hanging, model }),
          ),
        });
        const session = await host.createSession({ workDir });
        assertEquals(await host.esmState({ sessionId: session.sessionId }), {
          objective: null,
          workerRunning: false,
          activeAgentId: "",
        });
        const created = await host.esmUpdate({
          sessionId: session.sessionId,
          action: "create",
          objective: "ship the release",
        });
        assertEquals(created.objective?.objective, "ship the release");
        assertEquals(created.objective?.status, "active");

        // A paused objective cannot auto-run: no continuation starts.
        const paused = await host.esmUpdate({
          sessionId: session.sessionId,
          action: "pause",
        });
        assertEquals(paused.objective?.status, "paused");
        assertEquals(
          await host.esmContinue({ sessionId: session.sessionId }),
          { runId: "", started: false },
        );

        // Resuming starts the Core-owned worker; stopping terminalizes it.
        await host.esmUpdate({
          sessionId: session.sessionId,
          action: "resume",
        });
        const continuation = await host.esmContinue({
          sessionId: session.sessionId,
        });
        assertEquals(continuation.started, true);
        assert(continuation.runId !== "");
        assertEquals(
          (await host.esmState({ sessionId: session.sessionId })).workerRunning,
          true,
        );
        const events: CoreRuntimeEvent[] = [];
        const drain = (async () => {
          for await (
            const event of host.subscribeRunEvents(
              session.sessionId,
              continuation.runId,
            )
          ) {
            events.push(event);
          }
        })();
        await host.esmStop({ sessionId: session.sessionId });
        await drain;
        assertEquals(events.at(-1)?.eventType, "esm_finished");
        assertEquals(events.at(-1)?.payload.status, "cancelled");
        assertEquals(
          (await host.esmState({ sessionId: session.sessionId })).workerRunning,
          false,
        );
        await host.close();
      } finally {
        await Deno.remove(workDir, { recursive: true });
      }
    }),
);

test(
  "production Core transient prompt answers over a read-only registry",
  () =>
    withIsolatedConfig(async () => {
      const workDir = await Deno.makeTempDir({
        prefix: "opensac-core-transient-",
      });
      const model = CORE_TEST_MODEL;
      const provider = new MockProvider("mock", [model], [
        { type: streamTextDelta, textDelta: "hello" },
        { type: streamDone, stopReason: "end_turn" },
      ]);
      try {
        const settings = defaultSettings();
        settings.sessionDir = join(workDir, "sessions");
        const host = await createCoreRuntimeHost({
          source: SOURCE_ACP,
          workDir,
          settings,
          providerName: "mock",
          modelID: model.id,
          dependencies: createProductionCoreRuntimeDependencies(
            settings,
            () => ({ provider, model }),
          ),
        });
        const session = await host.createSession({ workDir });
        const result = await host.transientPrompt({
          sessionId: session.sessionId,
          question: "what is this?",
        });
        assertEquals(result.answer, "hello");
        await host.close();
      } finally {
        await Deno.remove(workDir, { recursive: true });
      }
    }),
);

test(
  "production Core compact runs as an event-only run",
  () =>
    withIsolatedConfig(async () => {
      const workDir = await Deno.makeTempDir({
        prefix: "opensac-core-compact-",
      });
      const model = CORE_TEST_MODEL;
      const provider = new MockProvider("mock", [model], [
        { type: streamTextDelta, textDelta: "summary" },
        { type: streamDone, stopReason: "end_turn" },
      ]);
      try {
        const settings = defaultSettings();
        settings.sessionDir = join(workDir, "sessions");
        const host = await createCoreRuntimeHost({
          source: SOURCE_ACP,
          workDir,
          settings,
          providerName: "mock",
          modelID: model.id,
          dependencies: createProductionCoreRuntimeDependencies(
            settings,
            () => ({ provider, model }),
          ),
        });
        const session = await host.createSession({ workDir });
        // Without conversation history the compaction is a completed no-op.
        const skipped = await host.compact({ sessionId: session.sessionId });
        const skippedEvents: CoreRuntimeEvent[] = [];
        for await (
          const event of host.subscribeRunEvents(
            session.sessionId,
            skipped.runId,
          )
        ) {
          skippedEvents.push(event);
        }
        assertEquals(skippedEvents.at(-1)?.eventType, "run_finished");
        assertEquals(skippedEvents.at(-1)?.payload.compact, "skipped");

        // After one conversation turn the compaction runs to completion.
        const accepted = await host.prompt({
          sessionId: session.sessionId,
          text: "hi",
        });
        for await (
          const _event of host.subscribeRunEvents(
            session.sessionId,
            accepted.runId,
          )
        ) {
          // drain
        }
        const compacted = await host.compact({ sessionId: session.sessionId });
        const compactedEvents: CoreRuntimeEvent[] = [];
        for await (
          const event of host.subscribeRunEvents(
            session.sessionId,
            compacted.runId,
          )
        ) {
          compactedEvents.push(event);
        }
        const terminal = compactedEvents.at(-1);
        assertEquals(terminal?.eventType, "run_finished");
        assertEquals(terminal?.payload.status, "completed");
        assertEquals(terminal?.payload.compact, "done");
        await host.close();
      } finally {
        await Deno.remove(workDir, { recursive: true });
      }
    }),
);

test(
  "production Core session source and run policy reach the canonical run record",
  () =>
    withIsolatedConfig(async () => {
      const workDir = await Deno.makeTempDir({
        prefix: "opensac-core-policy-",
      });
      const model = CORE_TEST_MODEL;
      const provider = new MockProvider("mock", [model], [
        { type: streamTextDelta, textDelta: "hello" },
        { type: streamDone, stopReason: "end_turn" },
      ]);
      try {
        const settings = defaultSettings();
        settings.sessionDir = join(workDir, "sessions");
        const host = await createCoreRuntimeHost({
          source: SOURCE_ACP,
          workDir,
          settings,
          providerName: "mock",
          modelID: model.id,
          dependencies: createProductionCoreRuntimeDependencies(
            settings,
            () => ({ provider, model }),
          ),
        });
        const session = await host.createSession({
          workDir,
          source: "cli",
          approvalPolicy: "print",
          questionPolicy: "unattended",
        });
        assertEquals(session.source, "cli");
        assertEquals(session.approvalPolicy, "print");
        assertEquals(session.questionPolicy, "unattended");

        const accepted = await host.prompt({
          sessionId: session.sessionId,
          text: "hi",
        });
        for await (
          const _event of host.subscribeRunEvents(
            session.sessionId,
            accepted.runId,
          )
        ) {
          // drain
        }

        // The canonical run and intent keep the source and decision policy.
        const sessionDir = join(workDir, "sessions");
        const run = getDurableRun(sessionDir, accepted.runId);
        assert(run !== null);
        assertEquals(run.source, "cli");
        const intent = getExecutionIntent(sessionDir, run.intentId);
        assert(intent !== null);
        const policy = intent.policy as {
          source: string;
          approvalPolicy: string;
          questionPolicy: string;
        };
        assertEquals(policy.source, "cli");
        assertEquals(policy.approvalPolicy, "print");
        assertEquals(policy.questionPolicy, "unattended");
        await host.close();
      } finally {
        await Deno.remove(workDir, { recursive: true });
      }
    }),
);

test("production prompt holds the execution lease the ownership fence revalidates", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "opensac-core-lease-" });
  const model: Model = {
    id: "mock-model",
    name: "Mock Model",
    provider: "mock",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 1024,
  };
  // Gate the mock stream so the lease assertions run while the run is live.
  let releaseStream!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseStream = resolve;
  });
  class GatedProvider extends MockProvider {
    override async *chat(params: ChatParams): AsyncGenerator<StreamEvent> {
      await gate;
      yield* super.chat(params);
    }
  }
  const provider = new GatedProvider("mock", [model], [
    { type: streamTextDelta, textDelta: "hello" },
    { type: streamDone, stopReason: "end_turn" },
  ]);
  try {
    const settings = defaultSettings();
    const host = await createCoreRuntimeHost({
      source: SOURCE_ACP,
      workDir,
      settings,
      providerName: "mock",
      modelID: model.id,
      dependencies: createProductionCoreRuntimeDependencies(
        settings,
        () => ({ provider, model }),
      ),
    });
    const session = await host.createSession({ workDir });
    const accepted = await host.prompt({
      sessionId: session.sessionId,
      text: "hi",
    });
    const sessionDir = getSessionDir(settings);
    // Regression: the prompt path never acquired the execution admission, so
    // the ownership fence's final revalidation threw and every side-effecting
    // tool was blocked ("tool execution blocked by Runtime ownership fence").
    validateRuntimeLease(
      sessionDir,
      session.sessionId,
      accepted.runId,
      "execution",
    );

    releaseStream();
    for await (
      const _event of host.subscribeRunEvents(session.sessionId, accepted.runId)
    ) {
      // Drain to the terminal event.
    }
    // Terminal runs release the admission so the next run can acquire it
    // (the release lands on the generator's completion, after the terminal
    // event was published).
    for (let i = 0; i < 200; i++) {
      if (currentRuntimeLeaseBinding(sessionDir, session.sessionId) === null) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assertEquals(
      currentRuntimeLeaseBinding(sessionDir, session.sessionId),
      null,
    );
    const second = await host.prompt({
      sessionId: session.sessionId,
      text: "again",
    });
    validateRuntimeLease(
      sessionDir,
      session.sessionId,
      second.runId,
      "execution",
    );
    for await (
      const _event of host.subscribeRunEvents(session.sessionId, second.runId)
    ) {
      // Drain to the terminal event.
    }
    await host.close();
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

test("transcript reprints the durable branch that the live event log cannot see", async () => {
  await withIsolatedConfig(async () => {
    const workDir = await Deno.makeTempDir({
      prefix: "opensac-core-transcript-",
    });
    try {
      const settings = defaultSettings();
      const sessionDir = join(workDir, "sessions");
      settings.sessionDir = sessionDir;
      const sessionId = "transcript-resume";

      // A conversation exactly as an earlier, finished run left it on disk.
      const manager = openOrCreateSession({
        workDir,
        sessionDir,
        id: sessionId,
      });
      manager.appendMessage({
        timestamp: new Date(1000),
        role: "user",
        content: "why is the build red",
      });
      manager.appendMessage({
        timestamp: new Date(2000),
        role: "assistant",
        contents: [{ type: "text", text: "because fmt failed" }],
      });
      // Runtime-injected guidance and tool traffic are not conversation turns
      // the user spoke, so a reprint must not render them as such.
      manager.appendMessage({
        timestamp: new Date(3000),
        role: "user",
        content: "injected skill guidance",
        systemInjected: true,
      });
      manager.appendMessage({
        timestamp: new Date(4000),
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "bash",
        content: "exit code 1",
      });
      manager.appendMessage({
        timestamp: new Date(5000),
        role: "assistant",
        contents: [
          { type: "text", text: "part one" },
          { type: "thinking", thinking: "hidden reasoning" },
          { type: "text", text: "part two" },
        ],
      });

      const host = await createCoreRuntimeHost({
        source: SOURCE_ACP,
        workDir,
        settings,
        providerName: "",
        modelID: "",
        dependencies: createProductionCoreRuntimeDependencies(settings),
      });
      try {
        await host.openSession({ sessionId });
        assertEquals(await host.transcript({ sessionId }), [
          { role: "user", text: "why is the build red" },
          { role: "assistant", text: "because fmt failed" },
          { role: "assistant", text: "part one\npart two" },
        ]);
        // The distinguishing property: this process never ran the session, so
        // the live log is empty and only the durable branch can reprint it.
        assertEquals(
          (await host.history({ sessionId })).length,
          0,
          "history is the live log, not the durable transcript",
        );
      } finally {
        await host.close();
      }
    } finally {
      await Deno.remove(workDir, { recursive: true });
    }
  });
});

test("transcript of a session with no conversation is empty, not an error", async () => {
  await withIsolatedConfig(async () => {
    const workDir = await Deno.makeTempDir({
      prefix: "opensac-core-transcript-empty-",
    });
    try {
      const settings = defaultSettings();
      settings.sessionDir = join(workDir, "sessions");
      const host = await createCoreRuntimeHost({
        source: SOURCE_ACP,
        workDir,
        settings,
        providerName: "",
        modelID: "",
        dependencies: createProductionCoreRuntimeDependencies(settings),
      });
      try {
        const session = await host.createSession({ workDir });
        assertEquals(
          await host.transcript({ sessionId: session.sessionId }),
          [],
        );
      } finally {
        await host.close();
      }
    } finally {
      await Deno.remove(workDir, { recursive: true });
    }
  });
});

test("openSession scoped to another work directory does not adopt the session", async () => {
  await withIsolatedConfig(async () => {
    const workDir = await Deno.makeTempDir({
      prefix: "opensac-core-open-scope-",
    });
    try {
      const settings = defaultSettings();
      settings.sessionDir = join(workDir, "sessions");
      const otherCwd = join(workDir, "other-project");
      await Deno.mkdir(otherCwd, { recursive: true });
      const host = await createCoreRuntimeHost({
        source: SOURCE_ACP,
        workDir,
        settings,
        providerName: "",
        modelID: "",
        dependencies: createProductionCoreRuntimeDependencies(settings),
      });
      try {
        const session = await host.createSession({ workDir: otherCwd });
        await host.closeSession({ sessionId: session.sessionId });
        // The same id resolved against a different work directory must fail
        // rather than be adopted under the wrong cwd.
        await assertRejects(
          () =>
            host.openSession({
              sessionId: session.sessionId,
              workDir,
            }),
          Error,
        );
        // Scoped to its own directory it opens normally.
        const reopened = await host.openSession({
          sessionId: session.sessionId,
          workDir: otherCwd,
        });
        assertEquals(reopened.sessionId, session.sessionId);
        assertEquals(reopened.workDir, otherCwd);
      } finally {
        await host.close();
      }
    } finally {
      await Deno.remove(workDir, { recursive: true });
    }
  });
});

test("openSession scoped to the caller directory resolves a foreign Core startup dir", async () => {
  await withIsolatedConfig(async () => {
    const workDir = await Deno.makeTempDir({
      prefix: "opensac-core-open-scoped-",
    });
    try {
      const settings = defaultSettings();
      settings.sessionDir = join(workDir, "sessions");
      // The shared Core started in one directory while this front end's project
      // is another: an unscoped open would resolve against the former and fail
      // for a session that really does exist in the latter.
      const coreStart = join(workDir, "core-start");
      await Deno.mkdir(coreStart, { recursive: true });
      const frontEndDir = join(workDir, "front-end");
      await Deno.mkdir(frontEndDir, { recursive: true });

      const manager = openOrCreateSession({
        workDir: frontEndDir,
        sessionDir: settings.sessionDir,
        id: "front-end-session",
      });
      manager.appendMessage({
        timestamp: new Date(1000),
        role: "user",
        content: "the turn made in the front end directory",
      });

      const host = await createCoreRuntimeHost({
        source: SOURCE_TUI,
        workDir: coreStart,
        settings,
        providerName: "",
        modelID: "",
        dependencies: createProductionCoreRuntimeDependencies(settings),
      });
      try {
        // Scoped to the directory the listing found it in, it opens and its
        // durable transcript is projected.
        const view = await host.openSession({
          sessionId: "front-end-session",
          workDir: frontEndDir,
        });
        assertEquals(view.workDir, frontEndDir);
        assertEquals(await host.transcript({ sessionId: view.sessionId }), [
          { role: "user", text: "the turn made in the front end directory" },
        ]);
        // Left to the Core's own startup directory it correctly refuses rather
        // than adopting the session under a cwd that is not its own.
        await host.closeSession({ sessionId: view.sessionId });
        await assertRejects(
          () => host.openSession({ sessionId: "front-end-session" }),
          Error,
          "not found for cwd",
        );
      } finally {
        await host.close();
      }
    } finally {
      await Deno.remove(workDir, { recursive: true });
    }
  });
});
