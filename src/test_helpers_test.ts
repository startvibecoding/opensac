import { assertEquals } from "./compat/assert.ts";
import { withIsolatedConfig } from "./test_helpers.ts";
import { test } from "#testing";

test("isolated config restores the caller's config directory", async () => {
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
