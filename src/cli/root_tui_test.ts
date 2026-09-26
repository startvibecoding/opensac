import { assertEquals, assertRejects } from "@std/assert";
import { defaultSettings } from "../config/settings.ts";
import { refreshWhenBusy, runInteractiveAction } from "./root_tui.ts";

Deno.test("interactive refresh skips idle redraws", () => {
  let rerenders = 0;
  const rerender = () => rerenders++;

  refreshWhenBusy(false, rerender);
  assertEquals(rerenders, 0);

  refreshWhenBusy(true, rerender);
  assertEquals(rerenders, 1);
});

Deno.test("runInteractiveAction requires a terminal instead of crashing Ink", async () => {
  await assertRejects(
    () =>
      runInteractiveAction(
        {
          provider: "",
          model: "",
          mode: "",
          thinking: "",
          workDir: Deno.cwd(),
        },
        defaultSettings(),
        { isTerminal: () => false },
      ),
    Error,
    "interactive mode requires a terminal",
  );
});
