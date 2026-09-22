// Process-bound integration test: build a real TUISession + SessionRuntime and
// verify /delegate on constructs the shared AgentManager and registers the
// blocking delegate tool (regression for the former stub).

import { assert, assertEquals } from "@std/assert";
import { TUISession } from "./tui_session.ts";
import { dispatchCommand } from "./commands.ts";
import { defaultSettings } from "../config/settings.ts";

Deno.test("delegate on enables delegate mode against the shared runtime", async () => {
  const settings = defaultSettings();
  const provider = settings.defaultProvider ?? "openai";
  const session = new TUISession(
    {
      provider,
      model: settings.defaultModel ?? "",
      mode: "yolo",
      thinking: "",
      workDir: Deno.cwd(),
      version: "test",
    },
    settings,
  );
  await session.start();
  try {
    const result = await dispatchCommand("/delegate on", session);
    assertEquals(result.error, undefined, result.message);
    assert(result.message?.includes("ON"));
    // The blocking tool is now present in the runtime registry.
    const names = session.runtime.registry?.all().map((t) => t.name()) ?? [];
    assert(names.includes("delegate_subagent"));

    // status reflects ON; off removes the tool again.
    const status = await dispatchCommand("/delegate", session);
    assert(status.message?.includes("ON"));
    const off = await dispatchCommand("/delegate off", session);
    assertEquals(off.error, undefined);
    const after = session.runtime.registry?.all().map((t) => t.name()) ?? [];
    assert(!after.includes("delegate_subagent"));
  } finally {
    await session.runtime.shutdown();
  }
});
