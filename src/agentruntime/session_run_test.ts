import { assertEquals } from "@opensac/assert";
import {
  createSessionExecutionRuntime,
  createSessionRunDescriptor,
} from "./session_run.ts";

Deno.test("createSessionRunDescriptor builds the canonical durable Run inputs", async () => {
  const startedAt = new Date("2026-09-25T00:00:00.000Z");
  const userMessage = { role: "user", content: "hello", timestamp: startedAt };
  const descriptor = await createSessionRunDescriptor({
    sessionId: "session-1",
    runId: "run-1",
    source: "tui",
    model: "model-1",
    mode: "yolo",
    workDir: "/tmp/project",
    text: "hello",
    userMessage,
    resourceIds: ["resource-1"],
    startedAt,
  });

  assertEquals(descriptor.intent.sessionId, "session-1");
  assertEquals(
    descriptor.intent.requestFingerprint.startsWith("sha256:"),
    true,
  );
  assertEquals(descriptor.intent.request, {
    message: "hello",
    model: "model-1",
    mode: "yolo",
    workDir: "/tmp/project",
  });
  assertEquals(descriptor.run.id, "run-1");
  assertEquals(descriptor.run.userMessage, userMessage);
  assertEquals(descriptor.startEvent.eventType, "started");
  assertEquals(
    descriptor.startEvent.data,
    JSON.stringify({
      intentId: descriptor.intent.id,
      attempt: 1,
    }),
  );
  assertEquals(descriptor.startEvent.sessionId, "session-1");
});

Deno.test("createSessionRunDescriptor preserves adapter policy", async () => {
  const descriptor = await createSessionRunDescriptor({
    sessionId: "session-1",
    runId: "run-1",
    source: "cli",
    model: "model-1",
    mode: "yolo",
    workDir: "/tmp/project",
    text: "hello",
    userMessage: {
      role: "user",
      content: "hello",
      timestamp: new Date("2026-09-25T00:00:00.000Z"),
    },
    resourceIds: [],
    startedAt: new Date("2026-09-25T00:00:00.000Z"),
    policy: { approvalPolicy: "print", questionPolicy: "unattended" },
  });

  assertEquals(descriptor.intent.policy, {
    approvalPolicy: "print",
    questionPolicy: "unattended",
  });
});

Deno.test("createSessionExecutionRuntime wires the shared run persistence", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "session-run-" });
  try {
    const execution = createSessionExecutionRuntime(sessionDir);
    assertEquals(execution.active().active, false);
    assertEquals(execution.active().runId, "");
  } finally {
    Deno.removeSync(sessionDir, { recursive: true });
  }
});
