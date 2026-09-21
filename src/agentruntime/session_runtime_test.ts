// Translated from internal/agentruntime/artifact_test.go, attach_test.go,
// session_runtime_bind_test.go, and the expert/model/mode cases of
// session_runtime_config_test.go.
//
// Deviations: the async resource loaders are awaited; mock/`SessionRuntime`
// construction uses the ported camelCase API; `t.TempDir()` maps to
// `Deno.makeTempDirSync`.

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import type { Model } from "../provider/types.ts";
import { thinkingHigh, thinkingMedium } from "../provider/types.ts";
import { newMockProvider } from "../provider/mock.ts";
import { newManager } from "../session/manager.ts";
import { closeDatabases } from "../session/root_db.ts";
import { newNoneSandbox } from "../sandbox/none.ts";
import { newRegistry } from "../tools/tool.ts";
import {
  defaultInputPolicy,
  type InputIngress,
  InputMaterializer,
} from "./input_materializer.ts";
import { AttachmentFile } from "./attachment.ts";
import { AttachmentService } from "./input.ts";
import { defaultAttachmentPolicy } from "./attachment.ts";
import type { SessionAttachment } from "./attachment.ts";
import { ExpertSwitchRequiresForkError } from "./expert.ts";
import {
  ConfigOptionExpert,
  ConfigOptionModel,
  ConfigOptionThinkingLevel,
} from "./session_options.ts";
import { attachSessionResources } from "./attach.ts";
import { buildRegistry } from "./registry.ts";
import { SessionRuntime } from "./session_runtime.ts";
import {
  ModeAgent,
  ModePlan,
  ModeYolo,
  SourceACP,
  SourceTUI,
} from "./source.ts";

function makeModel(overrides: Partial<Model> = {}): Model {
  return {
    id: "model",
    name: "Model",
    provider: "test-provider",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
    ...overrides,
  };
}

/** Creates [sessionRoot, workDir, manager] like the Go `inputTestSession`. */
function inputTestSession(): {
  root: string;
  workDir: string;
  manager: ReturnType<typeof newManager>;
} {
  const root = Deno.makeTempDirSync({ prefix: "mothx-rt-root-" });
  const workDir = Deno.makeTempDirSync({ prefix: "mothx-rt-work-" });
  const manager = newManager(workDir, root);
  manager.init();
  return { root, workDir, manager };
}

function optionCurrentValue(
  options: { id: string; currentValue: string }[],
  id: string,
): string {
  for (const option of options) {
    if (option.id === id) return option.currentValue;
  }
  return "";
}

function writeExpertFixtures(workDir: string): void {
  const writeBundle = (
    name: string,
    expertType: string,
    persona: string,
    members: string[] = [],
  ): void => {
    const dir = `${workDir}/.opensac/experts/${name}`;
    Deno.mkdirSync(`${dir}/agents`, { recursive: true, mode: 0o700 });
    let team = "";
    if (members.length > 0) {
      const quoted = members.map((m) => `"${m}"`).join(",");
      team =
        `,"teamInfo":{"leadAgent":"${persona}","memberAgents":[${quoted}]},"members":[{"id":"${persona}","name":{"zh":"总监","en":"Boss"},"role":"lead"}`;
      for (const m of members) {
        team +=
          `,{"id":"${m}","name":{"zh":"成员-${m}","en":"Member"},"role":"member"}`;
      }
      team += "]";
    }
    const agentName = expertType === "agent" ? `,"agentName":"${persona}"` : "";
    const manifest =
      `{"schemaVersion":1,"name":"${name}","expertType":"${expertType}"${agentName},"displayName":{"zh":"${name}","en":"${name}"}${team}}`;
    Deno.writeTextFileSync(`${dir}/expert.json`, manifest);
    const writePersona = (id: string, role: string, body: string): void => {
      const content =
        `---\nname: ${id}\nrole: ${role}\ndescription: persona ${id}\n---\n${body}\n`;
      Deno.writeTextFileSync(`${dir}/agents/${id}.md`, content);
    };
    writePersona(persona, "lead", `LEAD-BODY-${name}`);
    for (const m of members) writePersona(m, "member", `MEMBER-BODY-${m}`);
  };
  writeBundle("studio", "team", "studio-lead", ["studio-a", "studio-b"]);
  writeBundle("solo", "agent", "solo-lead");
}

Deno.test("beginArtifactCollectionDisabledByDefault", () => {
  const registry = newRegistry(Deno.makeTempDirSync(), undefined);
  const runtime = new SessionRuntime({ registry });
  const collector = runtime.beginArtifactCollection("run-disabled");
  assertEquals(collector, null);
  assert(!registry.get("publish_artifact").ok);
});

Deno.test("setArtifactEnabledRejectsClosedRuntime", () => {
  const runtime = new SessionRuntime();
  runtime.setArtifactEnabled(true);
  assert(runtime.artifactCapabilitySnapshot());
  runtime.close();
  let threw = false;
  try {
    runtime.setArtifactEnabled(false);
  } catch {
    threw = true;
  }
  assert(threw, "expected a closed runtime update to fail");
  assert(runtime.artifactCapabilitySnapshot());
});

Deno.test("artifactCollectorObserverReceivesPersistedRecord", async () => {
  const { root, workDir, manager } = inputTestSession();
  try {
    const service = new AttachmentService(root, defaultAttachmentPolicy());
    const runtime = new SessionRuntime({
      id: manager.getHeader()!.id,
      workDir,
      attachments: service,
      registry: newRegistry(workDir, undefined),
      artifactEnabled: true,
    });
    const collector = runtime.beginArtifactCollection("run-observer")!;
    try {
      const observed: SessionAttachment[] = [];
      collector.setObserver((record) => observed.push(record));
      Deno.writeTextFileSync(`${workDir}/report.txt`, "observer content");
      const tool = runtime.registry!.get("publish_artifact");
      assert(tool.ok, "publish_artifact was not registered");
      await tool.tool.execute({}, { path: "report.txt" });
      const items = collector.artifacts();
      assertEquals(items.length, 1);
      assertEquals(observed.length, 1);
      const record = observed[0];
      assertEquals(record.id, items[0].id);
      assertEquals(record.status, "generated");
      assertEquals(record.filename, "report.txt");
      assertEquals(record.kind, AttachmentFile);
      const stored = service.Get(manager.getHeader()!.id, record.id);
      assertEquals(stored.status, "generated");
    } finally {
      collector.close();
    }
  } finally {
    closeDatabases();
  }
});

Deno.test("artifactCollectorObserverPanicDoesNotAffectRegistration", async () => {
  const { root, workDir, manager } = inputTestSession();
  try {
    const service = new AttachmentService(root, defaultAttachmentPolicy());
    const runtime = new SessionRuntime({
      id: manager.getHeader()!.id,
      workDir,
      attachments: service,
      registry: newRegistry(workDir, undefined),
      artifactEnabled: true,
    });
    const collector = runtime.beginArtifactCollection("run-panic")!;
    try {
      collector.setObserver(() => {
        throw new Error("observer projection failed");
      });
      Deno.writeTextFileSync(`${workDir}/panic.txt`, "panic safe");
      const record = await collector.register("panic.txt", "", "auto");
      assertEquals(record.status, "generated");
      assert(record.id !== "");
      collector.setObserver(null);
      Deno.writeTextFileSync(`${workDir}/second.txt`, "second");
      await collector.register("second.txt", "", "auto");
      assertEquals(collector.artifacts().length, 2);
      const stored = service.Get(manager.getHeader()!.id, record.id);
      assertEquals(stored.status, "generated");
    } finally {
      collector.close();
    }
  } finally {
    closeDatabases();
  }
});

Deno.test("attachSessionResourcesUsesManagerIdentity", async () => {
  const workDir = Deno.makeTempDirSync();
  const manager = newManager(workDir, Deno.makeTempDirSync());
  manager.init();
  try {
    const registry = newRegistry(workDir, newNoneSandbox());
    const runtime = await attachSessionResources({
      source: SourceACP,
      workDir,
      manager,
      registry,
    });
    assertEquals(runtime.id, manager.getHeader()!.id);
    assert(runtime.manager === manager);
    assert(runtime.registry === registry);
  } finally {
    closeDatabases();
  }
});

Deno.test("attachSessionResourcesRejectsIncompleteOwnership", async () => {
  await assertRejects(() =>
    attachSessionResources({ workDir: Deno.makeTempDirSync() })
  );
});

Deno.test("sessionRuntimeBindSessionUpdatesLazyIdentity", async () => {
  const workDir = Deno.makeTempDirSync();
  const manager = newManager(workDir, Deno.makeTempDirSync());
  manager.init();
  try {
    const runtime = new SessionRuntime({ source: SourceTUI, workDir });
    await runtime.bindSession(manager, SourceTUI);
    assert(runtime.manager === manager);
    assertEquals(runtime.id, manager.getHeader()!.id);
    assertEquals(runtime.workDir, manager.getHeader()!.cwd);
    assertEquals(runtime.source, SourceTUI);
  } finally {
    closeDatabases();
  }
});

Deno.test("bindSessionKeepsPreviousIdentityWhenPreparationFails", async () => {
  const workDir = Deno.makeTempDirSync();
  const sessionDir = Deno.makeTempDirSync();
  const first = newManager(workDir, sessionDir);
  first.init();
  try {
    const runtime = new SessionRuntime({ source: SourceTUI, workDir });
    await runtime.bindSession(first, SourceTUI);
    const invalid = newManager(workDir, sessionDir);
    invalid.init();
    invalid.setExpertBinding("does-not-exist");
    await assertRejects(() => runtime.bindSession(invalid, SourceTUI));
    assert(runtime.manager === first);
    assertEquals(runtime.id, first.getHeader()!.id);
  } finally {
    closeDatabases();
  }
});

Deno.test("sessionRuntimeBindSessionRejectsClosedRuntime", async () => {
  const manager = newManager(Deno.makeTempDirSync(), Deno.makeTempDirSync());
  manager.init();
  try {
    const runtime = new SessionRuntime({ source: SourceTUI });
    runtime.close();
    await assertRejects(() => runtime.bindSession(manager, SourceTUI));
  } finally {
    closeDatabases();
  }
});

Deno.test("buildRegistryAppliesAdapterPolicy", () => {
  const workDir = Deno.makeTempDirSync();
  const registry = buildRegistry(workDir, undefined, undefined, {
    registerDefaults: true,
    enablePlanTool: false,
    browser: false,
  });
  assert(!registry.get("plan").ok, "plan tool must be disabled");
  assert(registry.get("read").ok, "default tools must register");
  let mutated = false;
  buildRegistry(workDir, undefined, undefined, {
    registerDefaults: false,
    browser: false,
    mutators: [() => {
      mutated = true;
    }],
  });
  assert(mutated, "mutator did not run");
  let threw = false;
  try {
    buildRegistry("", undefined, undefined, {
      registerDefaults: false,
      browser: false,
    });
  } catch {
    threw = true;
  }
  assert(threw, "empty work directory must fail");
});

Deno.test("sessionRuntimeExpertConfigOptionUsesRuntimeBindingRules", async () => {
  const workDir = Deno.makeTempDirSync();
  writeExpertFixtures(workDir);
  const manager = newManager(workDir, Deno.makeTempDirSync());
  manager.init();
  try {
    const model = makeModel();
    const p = newMockProvider("test-provider", [model], []);
    const runtime = new SessionRuntime({
      id: manager.getHeader()!.id,
      source: SourceACP,
      entrySource: SourceACP,
      workDir,
      manager,
    });
    runtime.configureSession(
      p,
      "test-provider",
      model,
      ModeYolo,
      thinkingMedium,
    );
    const expertOption = runtime.configOptions().find((o) =>
      o.id === ConfigOptionExpert
    )!;
    assert(expertOption.id !== "");
    assertEquals(expertOption.currentValue, "");
    assert(expertOption.options!.length >= 3);
    assertEquals(expertOption.options![0].value, "");
    await runtime.setConfigOption(ConfigOptionExpert, "studio");
    assertEquals(manager.getExpertId(), "studio");
    assert(runtime.teamExpertActive());
    assertEquals(
      optionCurrentValue(runtime.configOptions(), ConfigOptionExpert),
      "studio",
    );
    await assertRejects(
      () => runtime.setConfigOption(ConfigOptionExpert, "solo"),
      ExpertSwitchRequiresForkError,
    );
    await runtime.setConfigOption(ConfigOptionExpert, "");
    assertEquals(manager.getExpertId(), "");
    assert(!runtime.teamExpertActive());
  } finally {
    closeDatabases();
  }
});

Deno.test("sessionRuntimeConfigOptionsPersistModelModeThinking", async () => {
  const workDir = Deno.makeTempDirSync();
  const manager = newManager(workDir, Deno.makeTempDirSync());
  manager.init();
  try {
    const modelOne = makeModel({
      id: "model-one",
      name: "Model One",
      contextWindow: 32768,
      reasoning: true,
    });
    const modelTwo = makeModel({
      id: "model-two",
      name: "Model Two",
      contextWindow: 65536,
      reasoning: true,
    });
    const p = newMockProvider("test-provider", [modelOne, modelTwo], []);
    const runtime = new SessionRuntime({
      id: manager.getHeader()!.id,
      source: SourceACP,
      entrySource: SourceACP,
      workDir,
      manager,
    });
    runtime.configureSession(
      p,
      "test-provider",
      modelOne,
      ModeAgent,
      thinkingMedium,
    );
    assertEquals(
      optionCurrentValue(runtime.configOptions(), ConfigOptionModel),
      "test-provider/model-one",
    );
    await runtime.setConfigOption(ConfigOptionModel, "test-provider/model-two");
    await runtime.setConfigOption("mode", ModePlan);
    await runtime.setConfigOption(
      ConfigOptionThinkingLevel,
      thinkingHigh,
    );
    assertEquals(
      optionCurrentValue(runtime.configOptions(), ConfigOptionModel),
      "test-provider/model-two",
    );
    assertEquals(optionCurrentValue(runtime.configOptions(), "mode"), ModePlan);
  } finally {
    closeDatabases();
  }
});

const encoder = new TextEncoder();

function bytesIngress(
  overrides: Partial<InputIngress> & { content: Uint8Array },
): InputIngress {
  const { content, ...rest } = overrides;
  return {
    origin: "test",
    eventId: "evt-1",
    itemIndex: 0,
    reference: "",
    kind: "file",
    filenameHint: "note.txt",
    mediaTypeHint: "",
    sizeHint: 0,
    open: () => ({ bytes: content }),
    ...rest,
  };
}

Deno.test("sessionRuntimeAcceptInputBuildsCanonicalUserMessage", async () => {
  const { root, workDir, manager } = inputTestSession();
  try {
    const runtime = new SessionRuntime({
      id: manager.getHeader()!.id,
      workDir,
      inputs: new InputMaterializer(root, workDir, defaultInputPolicy()),
    });
    const submission = await runtime.acceptInput(
      undefined,
      "run-input",
      "please review",
      [bytesIngress({ content: encoder.encode("attachment body") })],
    );
    assertEquals(submission.text, "please review");
    assertEquals(submission.resources.length, 1);
    assert(submission.resources[0].resourceId !== "");
    const message = runtime.buildUserMessage(undefined, submission);
    const content = message.content ?? "";
    assert(content.includes("please review"));
    assert(content.includes("[Runtime-managed input files"));
    // Discarding only unbound resources is safe and idempotent.
    runtime.discardInput(submission);
  } finally {
    closeDatabases();
  }
});

Deno.test("sessionRuntimeAttachPreparedInputRejectsUnavailable", async () => {
  const { root, workDir, manager } = inputTestSession();
  try {
    const runtime = new SessionRuntime({
      id: manager.getHeader()!.id,
      workDir,
      inputs: new InputMaterializer(root, workDir, defaultInputPolicy()),
    });
    const prepared = await runtime.prepareInput(
      undefined,
      bytesIngress({ content: encoder.encode("staged") }),
    );
    const attached = runtime.attachPreparedInput(undefined, "hi", [prepared]);
    assertEquals(attached.resources.length, 1);
    runtime.discardInput(attached);
    assertThrows(() =>
      runtime.attachPreparedInput(undefined, "hi", [prepared])
    );
  } finally {
    closeDatabases();
  }
});
