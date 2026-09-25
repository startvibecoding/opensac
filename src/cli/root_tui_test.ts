import { assertEquals } from "@std/assert";
import { refreshWhenBusy } from "./root_tui.ts";

Deno.test("interactive refresh skips idle redraws", () => {
  let rerenders = 0;
  const rerender = () => rerenders++;

  refreshWhenBusy(false, rerender);
  assertEquals(rerenders, 0);

  refreshWhenBusy(true, rerender);
  assertEquals(rerenders, 1);
});
