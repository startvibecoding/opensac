import { assert, assertEquals, assertRejects } from "../compat/assert.ts";
import { type CoreRuntimeEvent } from "../core/runtime.ts";
import {
  createFakeTUIService,
  runNotFoundError,
  sessionNotFoundError,
  TUIServiceError,
} from "./service.ts";
import { test } from "#testing";

test("fake TUIService admits a prompt and streams its run to a terminal event", async () => {
  const service = createFakeTUIService();
  const session = await service.createSession({
    workDir: "/workspace/project",
    providerName: "test-provider",
    modelID: "test-model",
  });
  const accepted = await service.prompt({
    sessionId: session.sessionId,
    text: "hello",
  });
  const events: CoreRuntimeEvent[] = [];
  for await (
    const event of service.subscribeRunEvents(session.sessionId, accepted.runId)
  ) {
    events.push(event);
  }
  assertEquals(accepted.status, "running");
  assertEquals(events.at(-1)?.eventType, "run_finished");
});

test("fake TUIService generates deterministic session and run IDs", async () => {
  const service = createFakeTUIService();
  const first = await service.createSession({ workDir: "/w" });
  const second = await service.createSession({ workDir: "/w" });
  assertEquals(first.sessionId, "session-1");
  assertEquals(second.sessionId, "session-2");
  // Effective-mode resolution stays Core-owned; the fake mirrors the product
  // default instead of letting adapters fill it in.
  assertEquals(first.mode, "yolo");
  const accepted = await service.prompt({
    sessionId: first.sessionId,
    text: "hello",
  });
  assertEquals(accepted.runId, "run-1");
});

test("fake TUIService rejects unknown sessions with stable errors", async () => {
  const service = createFakeTUIService();
  const missing = "session-missing";

  const assertSessionError = async (
    operation: () => Promise<unknown>,
  ): Promise<void> => {
    const error = await assertRejects(operation, TUIServiceError);
    assertEquals(error.message, sessionNotFoundError(missing).message);
    assertEquals(error.name, "TUIServiceError");
  };

  await assertSessionError(() => service.openSession({ sessionId: missing }));
  await assertSessionError(() =>
    service.prompt({ sessionId: missing, text: "hello" })
  );
  await assertSessionError(() =>
    service.cancelRun({ sessionId: missing, runId: "run-1" })
  );
  await assertSessionError(() =>
    service.setSessionConfig({ sessionId: missing, mode: "agent" })
  );
  await assertSessionError(() =>
    service.setSkillActive({
      sessionId: missing,
      name: "skill",
      active: true,
    })
  );
  await assertSessionError(() => service.closeSession({ sessionId: missing }));
  await assertSessionError(() =>
    service.addAttachment({
      sessionId: missing,
      name: "a.png",
      mediaType: "image/png",
      contentBase64: "aGk=",
    })
  );
  await assertSessionError(() => service.capabilities({ sessionId: missing }));
});

test("fake TUIService rejects unknown runs with a stable error", async () => {
  const service = createFakeTUIService();
  const session = await service.createSession({ workDir: "/w" });
  const error = await assertRejects(
    () =>
      service.cancelRun({
        sessionId: session.sessionId,
        runId: "run-missing",
      }),
    TUIServiceError,
  );
  assertEquals(
    error.message,
    runNotFoundError(session.sessionId, "run-missing").message,
  );
});

test("fake TUIService emits only events after the requested cursor", async () => {
  const service = createFakeTUIService();
  const session = await service.createSession({ workDir: "/w" });
  const accepted = await service.prompt({
    sessionId: session.sessionId,
    text: "hello",
  });

  const collect = async (
    cursor: number,
  ): Promise<CoreRuntimeEvent[]> => {
    const events: CoreRuntimeEvent[] = [];
    for await (
      const event of service.subscribeRunEvents(
        session.sessionId,
        accepted.runId,
        cursor,
      )
    ) {
      events.push(event);
    }
    return events;
  };

  assertEquals((await collect(0)).map((event) => event.sequence), [1, 2]);
  assertEquals(
    (await collect(1)).map((event) => event.eventType),
    ["run_finished"],
  );
  assertEquals(await collect(2), []);
});

test("fake TUIService streams live emitted events until a terminal event", async () => {
  const service = createFakeTUIService();
  const session = await service.createSession({ workDir: "/w" });
  service.emit(session.sessionId, "run-live", "run_started", { text: "x" });

  const iterator = service.subscribeRunEvents(
    session.sessionId,
    "run-live",
    0,
  );
  assertEquals(
    (await iterator.next()).value?.eventType,
    "run_started",
  );

  // Events emitted after subscription are streamed live in order.
  const pending = iterator.next();
  service.emit(session.sessionId, "run-live", "tool_call", { name: "ls" });
  assertEquals((await pending).value?.eventType, "tool_call");

  const pendingTerminal = iterator.next();
  service.emit(session.sessionId, "run-live", "run_finished", {
    status: "completed",
  }, true);
  assertEquals((await pendingTerminal).value?.eventType, "run_finished");

  // The stream completes after the terminal event.
  assertEquals(await iterator.next(), { done: true, value: undefined });
});

test("fake TUIService cancelRun terminalizes a running run once", async () => {
  const service = createFakeTUIService();
  const session = await service.createSession({ workDir: "/w" });
  service.emit(session.sessionId, "run-c", "run_started", { text: "x" });

  const cancelled = await service.cancelRun({
    sessionId: session.sessionId,
    runId: "run-c",
  });
  assertEquals(cancelled.status, "cancelled");

  const events: CoreRuntimeEvent[] = [];
  for await (
    const event of service.subscribeRunEvents(session.sessionId, "run-c")
  ) {
    events.push(event);
  }
  assertEquals(events.map((event) => event.eventType), [
    "run_started",
    "run_finished",
  ]);
  assertEquals(events.at(-1)?.terminal, true);

  // A second cancel observes the terminal state without a new event.
  assertEquals(
    (await service.cancelRun({
      sessionId: session.sessionId,
      runId: "run-c",
    })).status,
    "cancelled",
  );
});

test("fake TUIService projects config, skills, attachments, and capabilities", async () => {
  const service = createFakeTUIService();
  const session = await service.createSession({
    workDir: "/w",
    capabilities: { multiAgent: true },
  });

  const updated = await service.setSessionConfig({
    sessionId: session.sessionId,
    mode: "agent",
    modelID: "model-2",
  });
  assertEquals(updated.mode, "agent");
  assertEquals(updated.modelID, "model-2");
  assertEquals(updated.workDir, "/w");

  const skilled = await service.setSkillActive({
    sessionId: session.sessionId,
    name: "review",
    active: true,
  });
  assertEquals(skilled.sessionId, session.sessionId);
  await assertRejects(
    () =>
      service.setSkillActive({
        sessionId: session.sessionId,
        name: "  ",
        active: true,
      }),
    TUIServiceError,
    "skill name is required",
  );

  const attachment = await service.addAttachment({
    sessionId: session.sessionId,
    name: "note.txt",
    mediaType: "text/plain",
    contentBase64: "aGk=", // "hi"
  });
  assertEquals(attachment.name, "note.txt");
  assertEquals(attachment.size, 2);
  assert(attachment.attachmentId.startsWith("attachment-"));

  assertEquals(await service.capabilities({ sessionId: session.sessionId }), {
    multiAgent: { enabled: true, available: true },
  });
});

test("fake TUIService projects skills, prepared inputs, and settings", async () => {
  const service = createFakeTUIService();
  const session = await service.createSession({ workDir: "/w" });

  await service.setSkillActive({
    sessionId: session.sessionId,
    name: "demo",
    active: true,
  });
  const skills = await service.listSkills({ sessionId: session.sessionId });
  assertEquals(
    skills.map((skill) => [skill.name, skill.active]),
    [["demo", true]],
  );

  const prepared = await service.prepareInput({
    sessionId: session.sessionId,
    name: "clipboard.png",
    mediaType: "image/png",
    contentBase64: "aGk=",
    kind: "image",
  });
  assertEquals(prepared.resourceId, "resource-1");
  assertEquals(prepared.kind, "image");
  assertEquals(prepared.bytes, 2);

  const attachment = await service.addAttachment({
    sessionId: session.sessionId,
    name: "note.txt",
    mediaType: "text/plain",
    contentBase64: "aGk=",
  });
  assertEquals(
    await service.listAttachments({
      sessionId: session.sessionId,
    }),
    [attachment],
  );

  const settings = await service.settings();
  assertEquals(settings.defaultMode, "yolo");
  assertEquals(
    settings.providers.map((provider) => provider.name),
    ["test-provider"],
  );
  assertEquals(settings.providers[0].models, [
    { id: "test-model", name: "Test Model" },
  ]);
});

test("fake TUIService round-trips settings documents and the provider catalog", async () => {
  const service = createFakeTUIService();
  const doc = await service.getSettings();
  assertEquals(doc.defaultProvider, "test-provider");
  const global = await service.getSettings({ scope: "global" });
  assertEquals(global.defaultModel, "test-model");

  const updated = await service.updateSettings({
    scope: "global",
    updates: { defaultModel: "next-model" },
  });
  assertEquals(updated.defaultModel, "next-model");
  assertEquals((await service.getSettings()).defaultModel, "next-model");
  await assertRejects(
    () => service.updateSettings({ scope: "project", updates: {} }),
    TUIServiceError,
  );

  const catalog = await service.listProviders();
  assertEquals(catalog.map((entry) => entry.id), ["test-provider"]);
  assertEquals(catalog[0].models, [{ id: "test-model", name: "Test Model" }]);
  await service.validateProviderModel({
    providerID: "test-provider",
    modelID: "test-model",
  });
  await assertRejects(
    () =>
      service.validateProviderModel({
        providerID: "nope",
        modelID: "nope",
      }),
    TUIServiceError,
    "provider model validation failed: nope/nope",
  );
});

test("fake TUIService replaces env documents and tracks session context", async () => {
  const service = createFakeTUIService();
  assertEquals(await service.listEnv(), {});
  assertEquals(await service.updateEnv({ vars: { A: "1" } }), { A: "1" });
  assertEquals(await service.listEnv(), { A: "1" });
  assertEquals(await service.updateEnv({ vars: {} }), {});

  const session = await service.createSession({ workDir: "/w" });
  assertEquals(
    await service.getSessionContext({ sessionId: session.sessionId }),
    { ruleContent: "", extraContext: "" },
  );
  const updated = await service.setSessionContext({
    sessionId: session.sessionId,
    ruleContent: "rules",
    extraContext: "extra",
  });
  assertEquals(updated, { ruleContent: "rules", extraContext: "extra" });
  // Absent fields keep their current value.
  const merged = await service.setSessionContext({
    sessionId: session.sessionId,
    extraContext: "more",
  });
  assertEquals(merged, { ruleContent: "rules", extraContext: "more" });

  const error = await assertRejects(
    () =>
      service.getSessionContext({
        sessionId: "session-missing",
      }),
    TUIServiceError,
  );
  assertEquals(error.message, sessionNotFoundError("session-missing").message);
});

test("fake TUIService tracks expert binding and forks child sessions", async () => {
  const service = createFakeTUIService();
  const session = await service.createSession({ workDir: "/w" });

  const experts = await service.listExperts({ sessionId: session.sessionId });
  assertEquals(experts.map((entry) => entry.name), ["demo-expert"]);
  const bundle = await service.showExpert({
    sessionId: session.sessionId,
    expertId: "demo-expert",
  });
  assertEquals(bundle.displayName.en, "Demo Expert");
  await assertRejects(
    () =>
      service.showExpert({
        sessionId: session.sessionId,
        expertId: "missing",
      }),
    TUIServiceError,
    "expert bundle not found: missing",
  );

  assertEquals(
    await service.expertState({ sessionId: session.sessionId }),
    { expertId: "" },
  );
  assertEquals(
    await service.setExpert({
      sessionId: session.sessionId,
      expertId: "demo-expert",
    }),
    { expertId: "demo-expert" },
  );
  // Switching one bound expert to another requires a fork.
  await assertRejects(
    () =>
      service.setExpert({
        sessionId: session.sessionId,
        expertId: "other-expert",
      }),
    TUIServiceError,
    "expert switch requires fork",
  );

  const child = await service.forkSession({
    sessionId: session.sessionId,
    expertId: "other-expert",
    titleMode: "",
  });
  assertEquals(child.sessionId, "session-2");
  assertEquals(child.workDir, "/w");
  // The expert applies only to the child branch.
  assertEquals(
    await service.expertState({ sessionId: session.sessionId }),
    { expertId: "demo-expert" },
  );
  assertEquals(
    await service.expertState({ sessionId: child.sessionId }),
    { expertId: "other-expert" },
  );
});
