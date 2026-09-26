// Process-bound integration test: build a real TUISession over the fake
// service and verify /delegate, /agent, and /compact route through the neutral
// TUIService surface (regression for the former shared-AgentManager bridge).
// The Core-side delegate tool registration is covered by
// `src/core/runtime_host_test.ts`.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { TUISession } from "./tui_session.ts";
import { createFakeTUIService, type FakeTUIService } from "./service.ts";
import { dispatchCommand } from "./commands.ts";

function makeSession(): { session: TUISession; service: FakeTUIService } {
  const service = createFakeTUIService();
  const session = new TUISession(
    {
      provider: "openai",
      model: "",
      mode: "yolo",
      thinking: "",
      workDir: Deno.cwd(),
      version: "test",
      multiAgent: true,
    },
    service,
  );
  return { session, service };
}

Deno.test("delegate on/off toggle flows through the service", async () => {
  const { session, service } = makeSession();
  await session.start();
  try {
    const result = await dispatchCommand("/delegate on", session);
    assertEquals(result.error, undefined, result.message);
    assertStringIncludes(result.message ?? "", "ON");
    const sessionId = session.serviceSessionID;
    assert(sessionId !== "", "service session must be bound");
    assertEquals(
      (await service.delegateState({ sessionId })).enabled,
      true,
    );

    // status reflects the service-owned state; off clears it again.
    const status = await dispatchCommand("/delegate", session);
    assertStringIncludes(status.message ?? "", "ON");
    const off = await dispatchCommand("/delegate off", session);
    assertEquals(off.error, undefined);
    assertEquals(
      (await service.delegateState({ sessionId })).enabled,
      false,
    );
  } finally {
    await session.close();
  }
});

Deno.test("agent listing and destroy project the service registry", async () => {
  const { session, service } = makeSession();
  await session.start();
  try {
    const sessionId = session.serviceSessionID;
    service.addAgent({ sessionId, id: "child-1" });
    const list = await dispatchCommand("/agent list", session);
    assertStringIncludes(list.message ?? "", "child-1");
    const missing = await dispatchCommand("/agent destroy ghost", session);
    assertEquals(missing.error, true);
    const destroyed = await dispatchCommand("/agent destroy child-1", session);
    assertEquals(destroyed.error, undefined, destroyed.message);
    assertEquals((await service.listAgents({ sessionId })).length, 0);
  } finally {
    await session.close();
  }
});

Deno.test("compact runs through the service and reports the terminal status", async () => {
  const { session } = makeSession();
  await session.start();
  try {
    const result = await dispatchCommand("/compact", session);
    assertEquals(result.error, undefined, result.message);
    assertEquals(result.message, session.translator.text("compact.done"));
  } finally {
    await session.close();
  }
});
