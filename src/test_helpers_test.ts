import { assertEquals } from "@std/assert";
import { withIsolatedConfig } from "./test_helpers.ts";

Deno.test("isolated config restores the caller's config directory", async () => {
  const previous = Deno.env.get("OPENSAC_DIR");
  let observed: string | undefined;

  await withIsolatedConfig(() => {
    observed = Deno.env.get("OPENSAC_DIR");
    assertEquals(observed !== undefined, true);
    assertEquals(observed === previous, false);
  });

  assertEquals(Deno.env.get("OPENSAC_DIR"), previous);
  assertEquals(observed !== undefined, true);
});
