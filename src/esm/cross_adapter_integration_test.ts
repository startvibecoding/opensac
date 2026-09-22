// Translated from internal/esm/cross_adapter_integration_test.go

import { assertEquals } from "@std/assert";
import { roleWorker, Supervisor } from "./runtime_core.ts";
import { statusActive } from "./state.ts";
import { cleanup, makeStore, RuntimeTestAdapter } from "./test_helpers.ts";

Deno.test("TUI and ACP adapters continue the same persisted objective", async () => {
  const { store, sessionID } = makeStore("opensac-esm-xadapt-");
  try {
    store.create(sessionID, "finish shared objective");
    const workerResponse =
      '{"status":"continue","summary":"TUI inspected the repository","evidence":["read source"],"remaining_work":["finish implementation"],"blockers":[]}';
    const tui = new RuntimeTestAdapter({ [roleWorker]: workerResponse });
    const acp = new RuntimeTestAdapter({ [roleWorker]: workerResponse });

    const first = await new Supervisor({ store, adapter: tui }).run(
      sessionID,
      "tui-run",
      Deno.makeTempDirSync(),
      "agent",
    );
    const second = await new Supervisor({ store, adapter: acp }).run(
      sessionID,
      "acp-run",
      Deno.makeTempDirSync(),
      "agent",
    );
    assertEquals(first.objective!.status, statusActive);
    assertEquals(second.objective!.status, statusActive);
    assertEquals(tui.roles, [roleWorker]);
    assertEquals(acp.roles, [roleWorker]);

    const persisted = store.get(sessionID);
    assertEquals(persisted.progressSummary, "TUI inspected the repository");
    assertEquals(persisted.remainingWork.length, 1);
  } finally {
    cleanup();
  }
});
